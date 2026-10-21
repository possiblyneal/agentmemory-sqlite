import { jaccardSimilarity } from "../state/schema.js";

const RESTATEMENT_OVERLAP = 0.5;

// Records that restate a topic in nearly the same words are the same claim;
// when their wording differs, the one touched later holds. Rank the older one
// just behind the newer so reinforcement cannot outvote a correction.
export function capBehindNewer<T extends { score: number }>(
  scored: T[],
  textOf: (item: T) => string,
  activeAt: (item: T) => number,
): void {
  const byRecency = [...scored].sort((a, b) => activeAt(b) - activeAt(a));
  for (let i = 1; i < byRecency.length; i++) {
    const older = byRecency[i];
    for (let j = 0; j < i; j++) {
      const newer = byRecency[j];
      if (activeAt(newer) === activeAt(older)) continue;
      if (jaccardSimilarity(textOf(newer), textOf(older)) < RESTATEMENT_OVERLAP) continue;
      older.score = Math.min(older.score, newer.score * 0.99);
    }
  }
}
