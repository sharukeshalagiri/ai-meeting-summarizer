import { randomUUID } from "crypto";
import {
  FINAL_STATES,
  PENDING_STATES,
  retryDelayMs,
  WAITING_STATES,
  type JobHandler,
  type JobQueue,
  type JobState,
  type QueueDefinition,
  type SendOptions,
} from "./queue";

/**
 * In-process JobQueue with pg-boss's semantics (see queue.ts).
 *
 * Used by tests and by JOBS_DRIVER=memory. Jobs live in a MemoryStore;
 * two queues sharing one store behave like two processes sharing one
 * database, which is how the tests simulate a killed worker or a
 * restart: the first queue stops (its running handlers are abandoned),
 * a second queue registers the same handlers on the same store and picks
 * the work up.
 *
 * Timing: with `autoRun` (the default) due jobs start on their own,
 * driven by setTimeout, so vitest fake timers advance delayed jobs.
 * Without it, a test calls runDue() / drain() and controls `now`.
 */

interface MemoryJob {
  id: string;
  name: string;
  data: object;
  key: string | null;
  state: JobState;
  retryCount: number;
  retryLimit: number;
  /** Epoch ms before which the job may not start. */
  startAfter: number;
  startedAt: number | null;
  /** The queue instance running it, while active. */
  worker: string | null;
}

interface Settled {
  promise: Promise<JobState>;
  resolve: (state: JobState) => void;
}

/** What survives a "restart": the jobs and the queue definitions. */
export class MemoryStore {
  jobs: MemoryJob[] = [];
  definitions = new Map<string, QueueDefinition>();
  settled = new Map<string, Settled>();
}

const DEFAULT_DEFINITION: QueueDefinition = {
  name: "",
  retryLimit: 0,
  retryDelaySeconds: 1,
  retryBackoff: false,
  expireInSeconds: 15 * 60,
};

/** "*\/N * * * *" -> N minutes; anything else is unsupported in memory. */
const everyMinutes = (cron: string): number | null => {
  const match = /^\*\/(\d+) \* \* \* \*$/.exec(cron.trim());
  return match ? Number(match[1]) : null;
};

export class MemoryQueue implements JobQueue {
  readonly driver = "memory" as const;
  readonly store: MemoryStore;
  private readonly now: () => number;
  private readonly autoRun: boolean;
  private readonly workerId = randomUUID();
  private readonly handlers = new Map<string, JobHandler<unknown>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private stopped = false;
  /**
   * Time a fired timer has reached. Timers advance it, so when a test
   * fakes setTimeout but not Date, a job delayed by 2 minutes still
   * counts as due once its timer fires.
   */
  private clockFloor = 0;

  constructor(
    options: { store?: MemoryStore; now?: () => number; autoRun?: boolean } = {}
  ) {
    this.store = options.store ?? new MemoryStore();
    this.now = options.now ?? Date.now;
    this.autoRun = options.autoRun ?? true;
  }

  async start(): Promise<void> {
    this.stopped = false;
  }

  /**
   * Stops picking up work. Handlers already running are abandoned, not
   * awaited: their jobs stay "active" in the store, exactly like a
   * process that was killed, until they expire.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  async createQueue(definition: QueueDefinition): Promise<void> {
    this.store.definitions.set(definition.name, definition);
  }

  private current(): number {
    return Math.max(this.now(), this.clockFloor);
  }

  private definition(name: string): QueueDefinition {
    return this.store.definitions.get(name) ?? { ...DEFAULT_DEFINITION, name };
  }

  async send<T extends object>(
    name: string,
    data: T,
    options: SendOptions = {}
  ): Promise<string | null> {
    const key = options.singletonKey ?? null;

    if (
      key !== null &&
      this.store.jobs.some(
        (job) =>
          job.name === name && job.key === key && WAITING_STATES.includes(job.state)
      )
    ) {
      return null;
    }

    const job: MemoryJob = {
      id: randomUUID(),
      name,
      data: structuredClone(data),
      key,
      state: "created",
      retryCount: 0,
      retryLimit: this.definition(name).retryLimit,
      startAfter: this.current() + (options.startAfterSeconds ?? 0) * 1000,
      startedAt: null,
      worker: null,
    };

    this.store.jobs.push(job);
    this.settledFor(job.id);
    this.kick(job.startAfter - this.current());

    return job.id;
  }

  async work<T>(name: string, handler: JobHandler<T>): Promise<void> {
    this.handlers.set(name, handler as JobHandler<unknown>);
    this.kick(0);
  }

  async schedule(name: string, cron: string, data: object = {}): Promise<void> {
    const minutes = everyMinutes(cron);
    if (minutes === null) {
      throw new Error(`MemoryQueue only supports "*/N * * * *" schedules, got "${cron}"`);
    }

    const tick = () => {
      if (this.stopped) return;
      void this.send(name, data, { singletonKey: `schedule:${name}` });
      this.later(minutes * 60 * 1000, tick);
    };

    this.later(minutes * 60 * 1000, tick);
  }

  async pending(name: string, singletonKey: string) {
    return this.store.jobs
      .filter(
        (job) =>
          job.name === name &&
          job.key === singletonKey &&
          PENDING_STATES.includes(job.state)
      )
      .map((job) => ({ id: job.id, state: job.state }));
  }

  async state(name: string, id: string): Promise<JobState | null> {
    return this.store.jobs.find((job) => job.name === name && job.id === id)?.state ?? null;
  }

  /** Resolves with the job's final state (completed, failed, cancelled). */
  whenSettled(id: string): Promise<JobState> {
    return this.settledFor(id).promise;
  }

  /** The job, for assertions. */
  job(id: string): Readonly<MemoryJob> | undefined {
    return this.store.jobs.find((job) => job.id === id);
  }

  /**
   * Starts every job that is due, after retrying jobs whose attempt
   * expired (their worker died). Returns how many started.
   */
  runDue(): number {
    if (this.stopped) return 0;

    const now = this.current();

    for (const job of this.store.jobs) {
      if (job.state !== "active" || job.startedAt === null) continue;
      if (this.running.has(job.id)) continue;

      const expiresAt = job.startedAt + this.definition(job.name).expireInSeconds * 1000;
      if (expiresAt <= now) this.failAttempt(job);
    }

    let started = 0;

    for (const job of this.store.jobs) {
      if (!WAITING_STATES.includes(job.state) || job.startAfter > now) continue;

      const handler = this.handlers.get(job.name);
      if (!handler) continue;

      const busy =
        job.key !== null &&
        this.store.jobs.some(
          (other) =>
            other !== job &&
            other.name === job.name &&
            other.key === job.key &&
            other.state === "active"
        );
      if (busy) continue;

      this.run(job, handler);
      started++;
    }

    return started;
  }

  /** Runs due jobs until nothing is due or running (tests). */
  async drain(): Promise<void> {
    for (let rounds = 0; rounds < 1000; rounds++) {
      const started = this.runDue();
      const running = [...this.running.values()];
      if (!started && running.length === 0) return;
      await Promise.allSettled(running);
    }

    throw new Error("MemoryQueue.drain: jobs keep re-queuing themselves");
  }

  private run(job: MemoryJob, handler: JobHandler<unknown>): void {
    job.state = "active";
    job.startedAt = this.current();
    job.worker = this.workerId;

    const attempt = job.retryCount;

    const promise = (async () => {
      let error: unknown = null;

      try {
        await handler({
          id: job.id,
          name: job.name,
          data: structuredClone(job.data),
          retryCount: job.retryCount,
          retryLimit: job.retryLimit,
        });
      } catch (caught) {
        error = caught ?? new Error("job failed");
      }

      // Abandoned (stop) or taken over after expiry: not ours to settle.
      if (this.stopped || job.worker !== this.workerId || job.retryCount !== attempt || job.state !== "active") {
        return;
      }

      if (error) {
        this.failAttempt(job);
      } else {
        job.state = "completed";
        job.worker = null;
        this.settledFor(job.id).resolve("completed");
      }
    })().finally(() => {
      this.running.delete(job.id);
      this.kick(0);
    });

    this.running.set(job.id, promise);
  }

  private failAttempt(job: MemoryJob): void {
    job.worker = null;

    if (job.retryCount < job.retryLimit) {
      const delay = retryDelayMs(this.definition(job.name), job.retryCount);
      job.retryCount++;
      job.state = "retry";
      job.startAfter = this.current() + delay;
      this.kick(delay);
      return;
    }

    job.state = "failed";
    this.settledFor(job.id).resolve("failed");
  }

  private settledFor(id: string): Settled {
    let entry = this.store.settled.get(id);

    if (!entry) {
      let resolve!: (state: JobState) => void;
      const promise = new Promise<JobState>((done) => {
        resolve = done;
      });
      entry = { promise, resolve };
      this.store.settled.set(id, entry);

      const known = this.store.jobs.find((job) => job.id === id);
      if (known && FINAL_STATES.includes(known.state)) resolve(known.state);
    }

    return entry;
  }

  private later(delayMs: number, fn: () => void): void {
    const target = this.current() + Math.max(0, delayMs);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.clockFloor = Math.max(this.clockFloor, target);
      fn();
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.timers.add(timer);
  }

  /** Schedules a runDue() pass (autoRun only). */
  private kick(delayMs: number): void {
    if (!this.autoRun || this.stopped) return;
    this.later(delayMs, () => this.runDue());
  }
}
