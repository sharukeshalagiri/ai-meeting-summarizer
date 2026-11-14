/**
 * Rules every summary prompt shares. Kept in one place so EXTRACT,
 * REDUCE and VERIFY cannot drift apart on the basics.
 */
export const TRANSCRIPT_FORMAT_V1 = `
The transcript is a list of lines in the form
  [#<idx> mm:ss] <speaker>: <text>
<idx> is the segment id. It is NOT a line number: ids can skip values
(for example 3000, 3001, 4000). Cite segments only by these ids.
`.trim();

export const GROUNDING_RULES_V1 = `
Rules:
- Use only information present in the transcript. Never invent
  decisions, tasks, owners, dates, numbers, names or questions.
- Every item must cite at least one segment id in "evidence", taken
  from the [#id] markers of the lines that actually say it. Never cite
  an id that is not in the transcript you were given.
- Owners and speakers are the names used in the transcript. Use null
  when the transcript does not say who.
- Quote deadlines and dates exactly as spoken ("by Friday", "end of
  next week"). Never convert a relative date into a calendar date.
- Ignore small talk, jokes, greetings and side remarks. A joke or an
  idea that was rejected or explicitly parked is not a task and not a
  decision.
- An empty section is correct and expected. Never pad a section to
  fill it.
- Be brief: one sentence per item, no filler words.
- "confidence" is a number from 0 to 1: how clearly the transcript
  supports the item. Use 0.9 or above only when it is stated outright.
`.trim();
