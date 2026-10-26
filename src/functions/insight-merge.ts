import { jaccardSimilarity } from "../state/schema.js";
import type { Insight, SemanticMemory } from "../types.js";
import { capSourceIds, MAX_SOURCE_LIST_IDS } from "./graph-provenance.js";

// Insights a cluster keeps once the startup collapse has run. One reflect pass
// writes at most this many per cluster.
export const INSIGHTS_PER_CLUSTER = 5;

// A Semantic Fact feeds a project's Reflect only when every cited Session that
// still exists is that project's: one stray Session must not carry another
// repo's fact into it (#323).
export function factBelongsToProject(
  fact: Pick<SemanticMemory, "sourceSessionIds">,
  project: string,
  sessionProjects: ReadonlyMap<string, string | undefined>,
): boolean {
  const known = fact.sourceSessionIds.filter((id) => sessionProjects.has(id));
  return known.length > 0 && known.every((id) => sessionProjects.get(id) === project);
}

export function insightClusterKey(
  project: string | undefined,
  concepts: string[],
): string {
  return `${project ?? ""}|${concepts.map((c) => c.toLowerCase()).sort().join(",")}`;
}

const lastUsedAt = (i: Insight): string => i.lastReinforcedAt ?? i.createdAt;

// Strongest evidence first: most reinforcements, then highest confidence, then
// most recently reinforced (else created).
export function compareSurvivor(a: Insight, b: Insight): number {
  return (
    b.reinforcements - a.reinforcements ||
    b.confidence - a.confidence ||
    lastUsedAt(b).localeCompare(lastUsedAt(a))
  );
}

// Strongest by confidence, then recency: what reflect shows the model.
export function compareShown(a: Insight, b: Insight): number {
  return b.confidence - a.confidence || lastUsedAt(b).localeCompare(lastUsedAt(a));
}

// The survivor whose content overlaps `insight` most (the first on a tie, so
// the stronger one).
export function nearestInsight(insight: Insight, survivors: Insight[]): Insight {
  const text = insight.content.trim().toLowerCase();
  let best = survivors[0];
  let bestScore = -1;
  for (const survivor of survivors) {
    const score = jaccardSimilarity(text, survivor.content.trim().toLowerCase());
    if (score > bestScore) {
      best = survivor;
      bestScore = score;
    }
  }
  return best;
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
}
