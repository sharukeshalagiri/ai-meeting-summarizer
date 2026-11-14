import * as chrono from "chrono-node";

/**
 * Resolves a deadline *as spoken* ("by Friday", "end of next week") into
 * a calendar date, in code rather than in the model.
 *
 * Why code: a language model asked to "convert Friday to a date" has no
 * reliable notion of when the meeting happened or in which timezone, and
 * it guesses silently. Here the model only quotes the phrase; this module
 * resolves it deterministically from the meeting's start time and
 * timezone, and returns null when the phrase is vague ("next sprint",
 * "soon", "next month"). A null is shown as the spoken phrase alone,
 * which is honest; a wrong date is not.
 */

export interface DateReference {
  /** When the meeting started; relative phrases are anchored here. */
  meetingStart: Date;
  /**
   * IANA zone of the meeting, e.g. "Europe/Berlin". Decides which
   * calendar day "tomorrow" is. Unknown zones fall back to UTC.
   */
  timezone?: string | null;
}

/** "YYYY-MM-DD" in the meeting's timezone. */
export type IsoDate = string;

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** True when `zone` is an IANA name this runtime knows. */
export const isValidTimezone = (zone: string | null | undefined): boolean => {
  if (!zone) return false;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const zoneOf = (ref: DateReference): string =>
  isValidTimezone(ref.timezone) ? (ref.timezone as string) : "UTC";

/** Calendar parts of `instant` as seen in `zone`. */
const partsIn = (instant: Date, zone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
};

/**
 * Offset of `zone` from UTC at `instant`, in minutes (UTC-5 is -300).
 * chrono takes a numeric offset; IANA names need this conversion, and
 * computing it at the meeting instant gets daylight saving right.
 */
export const offsetMinutes = (instant: Date, zone: string): number => {
  const p = partsIn(instant, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = Math.floor(instant.getTime() / 60000) * 60000;

  return Math.round((asUtc - truncated) / 60000);
};

const pad = (value: number) => String(value).padStart(2, "0");

/** Formats `instant` as the calendar day it falls on in `zone`. */
export const toIsoDate = (instant: Date, zone: string): IsoDate => {
  const p = partsIn(instant, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

/** Local calendar day of the meeting, as a UTC-midnight Date for maths. */
const meetingDay = (ref: DateReference): Date => {
  const p = partsIn(ref.meetingStart, zoneOf(ref));
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
};

const dayToIso = (day: Date): IsoDate =>
  `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(
    day.getUTCDate()
  )}`;

const addDays = (day: Date, days: number) =>
  new Date(day.getTime() + days * DAY_MS);

/** Friday of the week containing `day` (weeks start on Monday). */
const fridayOf = (day: Date): Date => {
  const weekday = day.getUTCDay(); // 0 = Sunday
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return addDays(day, mondayOffset + 4);
};

/**
 * Lowercases and strips the words people wrap deadlines in ("by", "no
 * later than", "before class") so chrono sees only the date phrase.
 */
export const normalizePhrase = (phrase: string): string =>
  phrase
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /^(by|before|until|till|due|on|no later than|at the latest by|latest by)\s+/,
      ""
    )
    .replace(/^the\s+/, "")
    .replace(/\s+(at the latest|latest|before class|after class)$/, "")
    .trim();

/** Phrases that sound like dates but name no specific day. */
const VAGUE =
  /^(soon|asap|later|eventually|at some point|next (sprint|quarter|month|year|week)|this (sprint|quarter|month|year|week)|in the (coming|next) (weeks|months|days)|q[1-4]|someday|whenever)$/;

/**
 * Deadline idioms chrono reads differently from how people mean them.
 * "End of the week" is the working week's Friday, not Sunday; "EOD" is
 * the meeting day itself.
 */
const resolveIdiom = (
  phrase: string,
  ref: DateReference
): IsoDate | null | undefined => {
  const today = meetingDay(ref);

  if (/^(today|eod|end of (the )?day|end of today|tonight|this evening)$/.test(phrase)) {
    return dayToIso(today);
  }

  if (/^(eow|end of (the |this )?week)$/.test(phrase)) {
    return dayToIso(fridayOf(today));
  }

  if (/^end of next week$/.test(phrase)) {
    return dayToIso(fridayOf(addDays(today, 7)));
  }

  if (/^(eom|end of (the |this )?month)$/.test(phrase)) {
    const last = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)
    );
    return dayToIso(last);
  }

  if (/^end of next month$/.test(phrase)) {
    const last = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 0)
    );
    return dayToIso(last);
  }

  // Not an idiom; let chrono try.
  return undefined;
};

/**
 * A bare weekday that names the meeting's own day ("by Monday" said on a
 * Monday) means next week's: a deadline is never "earlier today" when
 * someone bothers to name the day.
 */
const bareWeekday = (phrase: string): number | null => {
  const match = /^(this )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(
    phrase
  );
  return match ? WEEKDAYS.indexOf(match[2]) : null;
};

/**
 * Resolves a spoken deadline to "YYYY-MM-DD" in the meeting's timezone,
 * or null when the phrase is missing, vague or unparseable.
 */
export const resolveSpokenDate = (
  spoken: string | null | undefined,
  ref: DateReference
): IsoDate | null => {
  if (!spoken || !spoken.trim()) return null;
  if (Number.isNaN(ref.meetingStart.getTime())) return null;

  const phrase = normalizePhrase(spoken);

  if (!phrase || VAGUE.test(phrase)) return null;

  const idiom = resolveIdiom(phrase, ref);
  if (idiom !== undefined) return idiom;

  const zone = zoneOf(ref);
  const today = meetingDay(ref);

  const weekday = bareWeekday(phrase);
  if (weekday !== null) {
    const ahead = (weekday - today.getUTCDay() + 7) % 7 || 7;
    return dayToIso(addDays(today, ahead));
  }

  const results = chrono.parse(
    phrase,
    {
      instant: ref.meetingStart,
      timezone: offsetMinutes(ref.meetingStart, zone),
    },
    { forwardDate: true }
  );

  const first = results[0];
  if (!first) return null;

  // Only a phrase that pins a day counts: "next month" parses, but it
  // names no day, and inventing the 9th would be a guess.
  const start = first.start;
  if (!start.isCertain("day") && !start.isCertain("weekday")) return null;

  return toIsoDate(start.date(), zone);
};

/**
 * True when an ISO date lies before the meeting-zone "today" of `now`.
 * Used for the overdue flag; a non-ISO value (legacy free text) is never
 * overdue because it cannot be compared.
 */
export const isOverdue = (
  dueDate: string | null | undefined,
  now: Date,
  timezone?: string | null
): boolean => {
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return false;

  return dueDate < toIsoDate(now, isValidTimezone(timezone) ? (timezone as string) : "UTC");
};
