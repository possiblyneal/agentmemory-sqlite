import { jaccardSimilarity } from "../state/schema.js";
import type { Insight } from "../types.js";
import { capSourceIds, MAX_SOURCE_LIST_IDS } from "./graph-provenance.js";

// Two Insights of one cluster at or above this token Jaccard restate each
// other. Measured on the live store (docs/research/record-kind-counts.md):
// reflect's paraphrases overlap far less than a Memory's duplicates, so
// remember's 0.7 would match nothing; 0.3 matches ~6% of Insights against an
// earlier one in their cluster, 0.25 ~16%, and below that distinct angles on
// the same facts start to merge.
export const INSIGHT_PARAPHRASE_JACCARD = 0.3;

export function insightClusterKey(
  project: string | undefined,
  concepts: string[],
): string {
  return `${project ?? ""}|${concepts.map((c) => c.toLowerCase()).sort().join(",")}`;
}

export function restatesInsight(a: string, b: string): boolean {
  return (
    jaccardSimilarity(a.trim().toLowerCase(), b.trim().toLowerCase()) >=
    INSIGHT_PARAPHRASE_JACCARD
  );
}

// The strongest-evidenced Insight survives: most reinforcements, then highest
// confidence, then oldest.
export function compareSurvivor(a: Insight, b: Insight): number {
  return (
    b.reinforcements - a.reinforcements ||
    b.confidence - a.confidence ||
    a.createdAt.localeCompare(b.createdAt)
  );
}

// Folds `other` into `survivor`: reinforcements add up, the higher confidence
// and the later reinforcement stay, source ids are the union.
export function absorbInsight(survivor: Insight, other: Insight): void {
  survivor.reinforcements += other.reinforcements;
  survivor.confidence = Math.max(survivor.confidence, other.confidence);
  if (
    other.lastReinforcedAt &&
    (!survivor.lastReinforcedAt || other.lastReinforcedAt > survivor.lastReinforcedAt)
  ) {
    survivor.lastReinforcedAt = other.lastReinforcedAt;
  }
  survivor.sourceMemoryIds = capSourceIds(
    [...survivor.sourceMemoryIds, ...other.sourceMemoryIds],
    MAX_SOURCE_LIST_IDS,
  );
  survivor.sourceLessonIds = [
    ...new Set([...survivor.sourceLessonIds, ...other.sourceLessonIds]),
  ];
  survivor.sourceCrystalIds = [
    ...new Set([...survivor.sourceCrystalIds, ...other.sourceCrystalIds]),
  ];
}
