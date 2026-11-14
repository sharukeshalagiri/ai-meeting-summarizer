/**
 * Speaker name suggestions (pure; no I/O, no model).
 *
 * Signals, from the transcript and the recorder's roster:
 * - self_intro: the speaker says "I'm Priya", "my name is Priya",
 *   "this is Priya", "Priya here".
 * - roster: that name is in LiveSession.roster.
 * - addressed: another speaker calls them by that name ("thanks, Priya",
 *   "Priya, can you ...", "... what do you think, Priya?").
 *
 * A name is applied automatically ONLY with two signals: self_intro AND
 * (roster OR addressed by another speaker). One signal is a suggestion
 * the user can accept. This works with no roster (desktop recorder):
 * self-introduction plus being addressed is enough.
 *
 * Text is ASR output, where names are capitalized and ordinary words
 * after "I'm" usually are not; the patterns rely on that, and reject
 * possessives ("I'm Sam's manager") and a name followed by more of a
 * predicate ("I'm Frank about this").
 */

export type NameSignal = "self_intro" | "roster" | "addressed";

export interface NameTurn {
  idx: number;
  speakerId: string | null;
  /** "mic" segments are the user; never named from these signals. */
  channel?: string | null;
  text: string;
}

export interface NameSuggestion {
  speakerId: string;
  name: string;
  confidence: number;
  signals: NameSignal[];
  /** True when two independent signals agree. */
  autoApply: boolean;
}

/** Confidence for a suggestion backed by two signals (auto-applied). */
export const AUTO_APPLY_CONFIDENCE = 0.95;

/** Capitalized words that follow "I'm" without being names. */
const NOT_NAMES = new Set(
  [
    "sorry", "sure", "fine", "good", "great", "glad", "happy", "here",
    "back", "done", "okay", "ok", "not", "just", "so", "going", "trying",
    "also", "really", "still", "afraid", "excited", "ready", "late",
    "new", "busy", "free", "available", "confused", "curious", "honest",
    "honestly", "thinking", "wondering", "on", "in", "at", "the", "a",
    "an", "and", "but", "well", "yes", "yeah", "no", "hi", "hey",
    "hello", "thanks", "thank", "today", "tomorrow", "monday", "tuesday",
    "wednesday", "thursday", "friday", "saturday", "sunday", "english",
    "speaker", "everyone", "all", "you", "we", "they", "he", "she",
    "it", "what", "how", "why", "when", "where", "who", "can", "could",
    "would", "will", "do", "did", "are", "is", "let", "right", "now",
    "then", "maybe", "actually", "basically", "very", "quite", "pretty",
    "totally", "sort", "kind", "one",
  ].map((w) => w.toLowerCase())
);

const NAME = String.raw`([A-Z][a-z]+(?:[-'’][A-Z][a-z]+)?(?:\s+[A-Z][a-z]+(?:[-'’][A-Z][a-z]+)?)?)`;

/** Words after a name that keep "I'm <Name>" an introduction. */
const INTRO_CONTINUATION = String.raw`(?=\s*(?:[.,!?;:]|$)|\s+(?:and|here|from|with|speaking|joining|calling|by\s+the\s+way|on\s+the|over)\b)`;

const SELF_INTRO_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\b(?:[Mm]y name is|[Mm]y name's)\s+${NAME}(?!['’]s)`, "g"),
  new RegExp(String.raw`(?:^|[^A-Za-z])(?:I'm|I’m|I am)\s+${NAME}${INTRO_CONTINUATION}`, "g"),
  new RegExp(String.raw`(?:^|[.!?]\s+)(?:[Hh]i|[Hh]ey|[Hh]ello)?[, ]*(?:[Tt]his is|[Ii]t's|[Ii]t’s)\s+${NAME}${INTRO_CONTINUATION}`, "g"),
  new RegExp(String.raw`(?:^|[.!?]\s+)${NAME}\s+here\b`, "g"),
];

const ADDRESS_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\b(?:[Tt]hanks|[Tt]hank you|[Hh]i|[Hh]ey|[Hh]ello|[Oo]ver to you|[Gg]o ahead|[Ww]elcome)[,]?\s+${NAME}(?!['’]s)\b`, "g"),
  new RegExp(String.raw`(?:^|[.!?]\s+)${NAME},\s+(?:can|could|would|will|do|did|are|is|what|how|when|why|where|you|any)\b`, "g"),
  new RegExp(String.raw`,\s*${NAME}\s*\?`, "g"),
];

const isNameCandidate = (raw: string): string | null => {
  const name = raw.trim();
  const words = name.split(/\s+/);
  if (words.some((w) => NOT_NAMES.has(w.toLowerCase()))) return null;
  if (name.length < 2 || name.length > 40) return null;
  return name;
};

const collect = (patterns: RegExp[], text: string): string[] => {
  const found: string[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = isNameCandidate(match[1] ?? "");
      if (name) found.push(name);
    }
  }
  return found;
};

/** Names a speaker gives for themself in one segment. */
export const selfIntroductions = (text: string): string[] =>
  collect(SELF_INTRO_PATTERNS, text);

/** Names a speaker addresses someone else by in one segment. */
export const addressedNames = (text: string): string[] => {
  const intros = new Set(selfIntroductions(text).map((n) => n.toLowerCase()));
  return collect(ADDRESS_PATTERNS, text).filter(
    (n) => !intros.has(n.toLowerCase())
  );
};

/** True if the text could change a suggestion (cheap pre-check). */
export const mentionsAName = (text: string): boolean =>
  selfIntroductions(text).length > 0 || addressedNames(text).length > 0;

const sameName = (a: string, b: string) => {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === y) return true;
  // "Priya" matches the roster entry "Priya Sharma" and vice versa.
  const first = (s: string) => s.split(/\s+/)[0];
  return first(x) === first(y) && (!x.includes(" ") || !y.includes(" "));
};

/** The roster's spelling of a name, if the roster has it. */
const inRoster = (name: string, roster: string[]): string | null =>
  roster.find((entry) => sameName(entry, name)) ?? null;

/**
 * Suggestions per remote speaker, at most one name each.
 *
 * `excludedNames` (e.g. the user's own display name) are never
 * suggested for a remote speaker.
 */
export const suggestNames = (
  turns: NameTurn[],
  roster: string[] = [],
  excludedNames: string[] = []
): NameSuggestion[] => {
  const ordered = [...turns].sort((a, b) => a.idx - b.idx);
  const remote = (t: NameTurn) => t.speakerId && t.channel !== "mic";

  // self-introductions per speaker, and names the mic says about itself
  const intros = new Map<string, Map<string, number>>();
  const excluded = [...excludedNames];

  for (const turn of ordered) {
    const names = selfIntroductions(turn.text);
    if (names.length === 0 || !turn.speakerId) continue;
    if (!remote(turn)) {
      excluded.push(...names);
      continue;
    }
    const counts = intros.get(turn.speakerId) ?? new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    intros.set(turn.speakerId, counts);
  }

  // who addresses whom: name -> speakers who said it, and the next
  // different speaker after each address (a weak vote)
  const addressedBy = new Map<string, Set<string>>();
  const answerVotes = new Map<string, Map<string, number>>();

  ordered.forEach((turn, position) => {
    const names = addressedNames(turn.text);
    if (names.length === 0) return;
    const speaker = turn.speakerId ?? `anon-${turn.idx}`;

    for (const name of names) {
      const key = name.toLowerCase();
      const by = addressedBy.get(key) ?? new Set<string>();
      by.add(speaker);
      addressedBy.set(key, by);

      const next = ordered
        .slice(position + 1)
        .find((t) => t.speakerId && t.speakerId !== turn.speakerId);
      if (next && remote(next)) {
        const votes = answerVotes.get(next.speakerId!) ?? new Map<string, number>();
        votes.set(name, (votes.get(name) ?? 0) + 1);
        answerVotes.set(next.speakerId!, votes);
      }
    }
  });

  const isExcluded = (name: string) => excluded.some((e) => sameName(e, name));

  const candidates: NameSuggestion[] = [];
  const speakerIds = new Set([...intros.keys(), ...answerVotes.keys()]);

  for (const speakerId of speakerIds) {
    const introCounts = intros.get(speakerId);
    let suggestion: NameSuggestion | null = null;

    if (introCounts && introCounts.size > 0) {
      const ranked = [...introCounts.entries()].sort((a, b) => b[1] - a[1]);
      // Two different names introduced equally often: no suggestion.
      if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) continue;
      const name = ranked[0][0];
      if (isExcluded(name)) continue;

      const signals: NameSignal[] = ["self_intro"];
      const rosterName = inRoster(name, roster);
      if (rosterName) signals.push("roster");

      const by = addressedBy.get(name.toLowerCase());
      if (by && [...by].some((s) => s !== speakerId)) signals.push("addressed");

      const autoApply = signals.length >= 2;
      suggestion = {
        speakerId,
        name: rosterName && rosterName.length > name.length ? rosterName : name,
        confidence: autoApply ? AUTO_APPLY_CONFIDENCE : 0.7,
        signals,
        autoApply,
      };
    } else {
      const votes = answerVotes.get(speakerId);
      if (!votes) continue;
      const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
      if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) continue;
      const [name, count] = ranked[0];
      if (isExcluded(name)) continue;
      const signals: NameSignal[] = ["addressed"];
      const rosterName = inRoster(name, roster);
      if (rosterName) signals.push("roster");
      // Being answered after an address is indirect: never automatic.
      suggestion = {
        speakerId,
        name: rosterName ?? name,
        confidence: Math.min(0.8, 0.5 + 0.1 * count + (rosterName ? 0.1 : 0)),
        signals,
        autoApply: false,
      };
    }

    if (suggestion) candidates.push(suggestion);
  }

  // One name, one speaker: a name claimed by two speakers is ambiguous.
  return candidates.filter(
    (s) =>
      candidates.filter((o) => sameName(o.name, s.name)).length === 1
  );
};
