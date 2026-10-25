import { jaccardOverlap, jaccardText } from "../state/schema.js";

const RESTATEMENT_OVERLAP = 0.5;

// Records that restate a topic in nearly the same words are the same claim;
// when their wording differs, the one touched later holds. Rank the older one
// just behind the newer so reinforcement cannot outvote a correction.
export function capBehindNewer<T extends { score: number }>(
  scored: T[],
  textOf: (item: T) => string,
  activeAt: (item: T) => number,
): void {
  const byRecency = [...scored]
    .sort((a, b) => activeAt(b) - activeAt(a))
    .map((item) => ({ item, at: activeAt(item), text: jaccardText(textOf(item)) }));
  for (let i = 1; i < byRecency.length; i++) {
    const older = byRecency[i];
    for (let j = 0; j < i; j++) {
      const newer = byRecency[j];
      if (newer.at === older.at) continue;
      if (jaccardOverlap(newer.text, older.text) < RESTATEMENT_OVERLAP) continue;
      older.item.score = Math.min(older.item.score, newer.item.score * 0.99);
    }
  }
}
