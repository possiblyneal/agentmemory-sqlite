import { jaccardOverlap, jaccardText, type JaccardText } from "../state/schema.js";

export const RESTATEMENT_OVERLAP = 0.5;

// Jaccard overlap is at most the smaller token set's size over the larger's,
// so a pair this lopsided is skipped without intersecting the sets: a search
// caps hundreds of hits pairwise (#371). Empty sets go to jaccardOverlap's
// exact-text fallback.
function cannotOverlap(a: JaccardText, b: JaccardText): boolean {
  const [small, large] = [a.tokens.size, b.tokens.size].sort((x, y) => x - y);
  return small > 0 && small < RESTATEMENT_OVERLAP * large;
}

interface Entry<T> {
  item: T;
  at: number;
  text: JaccardText;
}

// A pair with overlap >= RESTATEMENT_OVERLAP shares a token among the first
// `floor(size / 2) + 1` of each set's tokens, rarest first (prefix filtering),
// so only pairs sharing a prefix token need the exact overlap. Every other
// pair is below the threshold and caps nothing.
function prefixOf(tokens: Set<string>, rank: Map<string, number>): string[] {
  const ordered = [...tokens].sort((a, b) => rank.get(a)! - rank.get(b)!);
  return ordered.slice(0, Math.floor(ordered.length / 2) + 1);
}

// Records that restate a topic in nearly the same words are the same claim;
// when their wording differs, the one touched later holds. Rank the older one
// just behind the newer so reinforcement cannot outvote a correction.
export function capBehindNewer<T extends { score: number }>(
  scored: T[],
  textOf: (item: T) => string,
  activeAt: (item: T) => number,
): void {
  const byRecency: Entry<T>[] = [...scored]
    .sort((a, b) => activeAt(b) - activeAt(a))
    .map((item) => ({ item, at: activeAt(item), text: jaccardText(textOf(item)) }));
  const frequency = new Map<string, number>();
  for (const { text } of byRecency) for (const token of text.tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const rank = new Map(
    [...frequency.keys()].sort((a, b) => frequency.get(a)! - frequency.get(b)! || (a < b ? -1 : 1)).map((token, i) => [token, i]),
  );
  const byPrefixToken = new Map<string, number[]>();
  const withoutTokens: number[] = [];
  for (let i = 0; i < byRecency.length; i++) {
    const older = byRecency[i];
    const candidates = new Set<number>();
    if (older.text.tokens.size === 0) {
      for (const j of withoutTokens) candidates.add(j);
    } else {
      for (const token of prefixOf(older.text.tokens, rank)) for (const j of byPrefixToken.get(token) ?? []) candidates.add(j);
    }
    for (const j of candidates) {
      const newer = byRecency[j];
      if (newer.at === older.at) continue;
      if (cannotOverlap(newer.text, older.text)) continue;
      if (jaccardOverlap(newer.text, older.text) < RESTATEMENT_OVERLAP) continue;
      older.item.score = Math.min(older.item.score, newer.item.score * 0.99);
    }
    if (older.text.tokens.size === 0) {
      withoutTokens.push(i);
      continue;
    }
    for (const token of prefixOf(older.text.tokens, rank)) {
      const posting = byPrefixToken.get(token);
      if (posting) posting.push(i);
      else byPrefixToken.set(token, [i]);
    }
  }
}
