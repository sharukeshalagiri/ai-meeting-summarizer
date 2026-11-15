import { logger } from "../lib/logger";
import type {
  JobHandler,
  JobQueue,
  JobState,
  QueueDefinition,
  SendOptions,
} from "./queue";
import { PENDING_STATES } from "./queue";

const log = logger.child({ module: "jobs.pgboss" });

/** The schema pg-boss creates and owns (not managed by Prisma). */
export const PGBOSS_SCHEMA = "pgboss";

/**
 * Prisma-only query parameters (`schema`, `connection_limit`, ...) mean
 * nothing to node-postgres, so they are dropped from the URL pg-boss uses.
 */
export const toPgConnectionString = (databaseUrl: string): string => {
  try {
    const url = new URL(databaseUrl);
    for (const param of ["schema", "connection_limit", "pool_timeout", "pgbouncer", "socket_timeout"]) {
      url.searchParams.delete(param);
    }
    return url.toString();
  } catch {
    return databaseUrl;
  }
};

type PgBossModule = typeof import("pg-boss");
type PgBossInstance = InstanceType<PgBossModule["PgBoss"]>;

/**
 * JobQueue on pg-boss. pg-boss is ESM-only; Node >= 22.12 can require()
 * it from this CommonJS build, and it is loaded lazily so code paths
 * (and tests) that never start the queue never load it.
 */
export class PgBossQueue implements JobQueue {
  readonly driver = "pgboss" as const;
  private boss: PgBossInstance | null = null;

  constructor(private readonly databaseUrl: string) {}

  private get instance(): PgBossInstance {
    if (!this.boss) throw new Error("The job queue has not been started");
    return this.boss;
  }

  async start(): Promise<void> {
    const { PgBoss } = await import("pg-boss");

    const boss = new PgBoss({
      connectionString: toPgConnectionString(this.databaseUrl),
      schema: PGBOSS_SCHEMA,
    });

    // pg-boss emits errors from its background loops; without a
    // listener an EventEmitter "error" would crash the process.
    boss.on("error", (error: unknown) => log.error("pg-boss error", error));

    await boss.start();
    this.boss = boss;
  }

  async stop(): Promise<void> {
    if (!this.boss) return;
    const boss = this.boss;
    this.boss = null;
    // graceful: lets running handlers finish up to the timeout; anything
    // still running is retried by the next process once it expires.
    await boss.stop({ graceful: true, timeout: 20_000 });
  }

  async createQueue(definition: QueueDefinition): Promise<void> {
    const options = {
      policy: "stately" as const,
      retryLimit: definition.retryLimit,
      retryDelay: definition.retryDelaySeconds,
      retryBackoff: definition.retryBackoff,
      expireInSeconds: definition.expireInSeconds,
      ...(definition.heartbeatSeconds
        ? { heartbeatSeconds: definition.heartbeatSeconds }
        : {}),
    };

    const existing = await this.instance.getQueue(definition.name);

    if (!existing) {
      await this.instance.createQueue(definition.name, options);
      return;
    }

    // Keeps retry/expiry settings in step with the code on every boot.
    await this.instance.updateQueue(definition.name, {
      retryLimit: options.retryLimit,
      retryDelay: options.retryDelay,
      retryBackoff: options.retryBackoff,
      expireInSeconds: options.expireInSeconds,
    });
  }

  send<T extends object>(
    name: string,
    data: T,
    options: SendOptions = {}
  ): Promise<string | null> {
    return this.instance.send(name, data, {
      ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
      ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
    });
  }

  async work<T>(name: string, handler: JobHandler<T>): Promise<void> {
    await this.instance.work<T>(name, async (jobs) => {
      // One job per fetch by default; loop anyway so a batch never
      // silently drops jobs.
      for (const job of jobs) {
        await handler({
          id: job.id,
          name: job.name,
          data: job.data,
          retryCount: job.retryCount,
          retryLimit: (job as { retryLimit?: number }).retryLimit ?? 0,
        });
      }
    });
  }

  async schedule(name: string, cron: string, data: object = {}): Promise<void> {
    await this.instance.schedule(name, cron, data);
  }

  async pending(name: string, singletonKey: string) {
    const jobs = await this.instance.findJobs<object>(name, { key: singletonKey });

    return jobs
      .filter((job) => PENDING_STATES.includes(job.state as JobState))
      .map((job) => ({ id: job.id, state: job.state as JobState }));
  }

  async state(name: string, id: string): Promise<JobState | null> {
    const [job] = await this.instance.findJobs<object>(name, { id });
    return (job?.state as JobState | undefined) ?? null;
  }
}
