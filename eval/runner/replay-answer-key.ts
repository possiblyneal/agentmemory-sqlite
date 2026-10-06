import { touchedFiles, type ReplaySession } from "./replay-transcript.js";

export interface FileNeed {
  kind: "file";
  file: string;
  turn: number;
  earlierSessionIds: string[];
}

export interface RepeatedCorrection {
  kind: "correction";
  turn: number;
  text: string;
  earlierSessionId: string;
  earlierTurn: number;
  earlierText: string;
}

export interface RevisitedDecision {
  kind: "decision";
  turn: number;
  text: string;
  earlierSessionId: string;
  earlierTurn: number;
  earlierText: string;
}

export type KeyItem = FileNeed | RepeatedCorrection | RevisitedDecision;

export interface AnswerKey {
  files: FileNeed[];
  corrections: RepeatedCorrection[];
  decisions: RevisitedDecision[];
}

const STOPWORDS = new Set(
  (
    "the and for that this with you your are was were have has had not but can could would should " +
    "will just from they them then than into about what when where which while there their here " +
    "also its our out all any more some been being does did doing done get got make made use using " +
    "please want need like let's lets one two now still"
  ).split(" "),
);

export const MIN_SHARED_TOKENS = 3;
export const MIN_OVERLAP = 0.5;
const MAX_CORRECTION_CHARS = 500;

const CORRECTION = [
  /^\s*(no|nope|wrong|stop|wait)\b/i,
  /\b(don'?t|do not|never)\b/i,
  /\bi (already |just )?(told|said|asked)\b/i,
  /\b(that'?s|this is) (not|wrong)\b/i,
  /\bnot what i\b/i,
  /\bstop (doing|using|adding|making)\b/i,
];

const DECISION = [
  /\b(decided|decision|going forward|from now on|go with)\b/i,
  /\bwe('ll| will) (use|go|keep)\b/i,
  /\blet'?s (use|go with|switch|keep|stick)\b/i,
];

export function contentTokens(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9_./-]*[a-z0-9]|[a-z0-9]/g) ?? [];
  return new Set(tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t)));
}

export function sharedTokens(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared;
}

// Two texts bear on each other when they share enough content words and those
// words are most of the shorter text.
export function bearsOn(a: string, b: string): boolean {
  const x = contentTokens(a);
  const y = contentTokens(b);
  return sharedTokens(x, y) >= MIN_SHARED_TOKENS && overlap(x, y) >= MIN_OVERLAP;
}

export function overlap(a: Set<string>, b: Set<string>): number {
  const smaller = Math.min(a.size, b.size);
  return smaller === 0 ? 0 : sharedTokens(a, b) / smaller;
}

export function isCorrection(text: string): boolean {
  return text.length <= MAX_CORRECTION_CHARS && CORRECTION.some((re) => re.test(text));
}

export function isDecision(text: string): boolean {
  return text.length <= MAX_CORRECTION_CHARS && DECISION.some((re) => re.test(text));
}

interface EarlierTurn {
  sessionId: string;
  turn: number;
  text: string;
  tokens: Set<string>;
}

function earlierTurns(earlier: ReplaySession[], keep: (text: string) => boolean): EarlierTurn[] {
  return earlier.flatMap((s) =>
    s.userTurns
      .filter((t) => keep(t.text))
      .map((t) => ({ sessionId: s.id, turn: t.turn, text: t.text, tokens: contentTokens(t.text) })),
  );
}

// Latest earlier turn with the best overlap, so a tie goes to the newest.
function bestMatch(text: string, pool: EarlierTurn[]): EarlierTurn | null {
  const tokens = contentTokens(text);
  let best: EarlierTurn | null = null;
  let bestOverlap = 0;
  for (const candidate of pool) {
    if (sharedTokens(tokens, candidate.tokens) < MIN_SHARED_TOKENS) continue;
    const o = overlap(tokens, candidate.tokens);
    if (o >= MIN_OVERLAP && o >= bestOverlap) {
      best = candidate;
      bestOverlap = o;
    }
  }
  return best;
}

export function filesNeeded(session: ReplaySession, earlier: ReplaySession[]): FileNeed[] {
  const touchedBy = new Map<string, string[]>();
  for (const s of earlier) {
    for (const file of touchedFiles(s)) touchedBy.set(file, [...(touchedBy.get(file) ?? []), s.id]);
  }
  const needs = new Map<string, FileNeed>();
  for (const use of session.fileUses) {
    const sessions = touchedBy.get(use.file);
    if (!sessions || needs.has(use.file)) continue;
    needs.set(use.file, { kind: "file", file: use.file, turn: use.turn, earlierSessionIds: sessions });
  }
  return [...needs.values()];
}

export function repeatedCorrections(session: ReplaySession, earlier: ReplaySession[]): RepeatedCorrection[] {
  const pool = earlierTurns(earlier, isCorrection);
  return session.userTurns.flatMap((t) => {
    if (!isCorrection(t.text)) return [];
    const match = bestMatch(t.text, pool);
    if (!match) return [];
    return [
      {
        kind: "correction" as const,
        turn: t.turn,
        text: t.text,
        earlierSessionId: match.sessionId,
        earlierTurn: match.turn,
        earlierText: match.text,
      },
    ];
  });
}

export function decisionsRevisited(session: ReplaySession, earlier: ReplaySession[]): RevisitedDecision[] {
  const pool = earlierTurns(earlier, isDecision);
  return session.userTurns.flatMap((t) => {
    if (isCorrection(t.text)) return [];
    const match = bestMatch(t.text, pool);
    if (!match) return [];
    return [
      {
        kind: "decision" as const,
        turn: t.turn,
        text: t.text,
        earlierSessionId: match.sessionId,
        earlierTurn: match.turn,
        earlierText: match.text,
      },
    ];
  });
}

// Only earlier Sessions of the same project count: Recall is scoped by
// project, so a Session of another project could never have been injected.
export function deriveAnswerKey(session: ReplaySession, allEarlier: ReplaySession[]): AnswerKey {
  const earlier = allEarlier.filter(
    (s) => s.id !== session.id && s.project === session.project && s.startedAt < session.startedAt,
  );
  return {
    files: filesNeeded(session, earlier),
    corrections: repeatedCorrections(session, earlier),
    decisions: decisionsRevisited(session, earlier),
  };
}
