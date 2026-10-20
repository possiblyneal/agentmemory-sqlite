import { KV } from "./schema.js";
import type { StateKV } from "./kv.js";
import type { CompressedObservation, SessionSummary } from "../types.js";

// A Session Summary's decisions are one BM25 document, keyed so it cannot
// collide with an Observation (obs_), Memory (mem_) or Lesson (lsn_) id.
const PREFIX = "summary:";

export const summaryIndexId = (sessionId: string): string => PREFIX + sessionId;

export const isSummaryIndexId = (id: string): boolean => id.startsWith(PREFIX);

// What a decision hit stands for in a result list: the Summary, in the
// Observation shape every result path already hands back.
export function summaryToObservation(summary: SessionSummary): CompressedObservation {
  return {
    id: summaryIndexId(summary.sessionId),
    sessionId: summary.sessionId,
    timestamp: summary.lastObservationAt ?? summary.coveredThrough ?? summary.createdAt,
    type: "decision",
    title: summary.title,
    facts: summary.keyDecisions,
    narrative: summary.keyDecisions.join("\n"),
    concepts: summary.concepts ?? [],
    files: summary.filesModified ?? [],
    importance: 5,
  };
}

// The indexed text is the title and the decisions. Files and concepts stay
// out so a Summary does not compete with the Observations that carry them.
// A Summary with no decisions has nothing to add: null, and the caller drops
// any document it had.
export function summaryToIndexDoc(summary: SessionSummary): CompressedObservation | null {
  if (!Array.isArray(summary.keyDecisions) || summary.keyDecisions.length === 0) return null;
  return { ...summaryToObservation(summary), facts: [], concepts: [], files: [] };
}

// The result record for a decision hit, read from the Summary as stored now.
// Null when the Summary is gone or has no decisions: the hit is stale.
export async function loadSummaryHit(kv: StateKV, indexId: string): Promise<CompressedObservation | null> {
  const summary = await kv
    .get<SessionSummary>(KV.summaries, indexId.slice(PREFIX.length))
    .catch(() => null);
  return summary?.keyDecisions?.length ? summaryToObservation(summary) : null;
}
