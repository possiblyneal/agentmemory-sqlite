import type { SqliteState } from "../engine/inproc/state.js";
import { DEAD_INDEX_SCOPE, DEAD_INDEX_SCOPE_PREFIX, KV, generateId } from "./schema.js";
import { capSourceIds, MAX_SOURCE_LIST_IDS } from "../functions/graph-provenance.js";
import { checkoutRootsOf } from "../functions/project-files.js";
import { mergeDuplicateFileNodes } from "./merge-file-nodes.js";
import { getConsolidationDecayDays, getMaxSourceObservationIds } from "../config.js";
import { decayedStrength } from "../functions/consolidation-pipeline.js";
import { logger } from "../logger.js";
import {
  absorbInsight,
  compareSurvivor,
  insightClusterKey,
  INSIGHTS_PER_CLUSTER,
  nearestInsight,
} from "../functions/insight-merge.js";
import type { Insight, SemanticMemory, Session, StateScope } from "../types.js";

// Bump when the pass gains a job that has to run against a store an earlier
// version already marked as done.
export const STARTUP_MAINTENANCE_VERSION = 3;

const MARKER_KEY: keyof StateScope = "system:startupMaintenanceVersion";

// Rows per SQL statement. Every statement blocks the event loop for its whole
// duration, so the pass yields between chunks and a chunk is sized to be short
// rather than to be efficient: requests arriving mid-pass get served between
// them instead of queueing behind one long scan. 100 is the chunk StateKV
// already bounds a setMany to, so one write lock is held no longer here than
// anywhere else.
const CHUNK_ROWS = 100;

export type StartupMaintenanceResult = {
  /** True when an earlier boot already completed this version of the pass. */
  skipped: boolean;
  /** Rows whose id list was over its bound and got trimmed. */
  rowsTrimmed: number;
  /** Ids dropped across all trimmed rows. */
  idsDropped: number;
  /** Duplicate file nodes folded into the node named by the project-relative path. */
  fileNodesMerged: number;
  /** Edges re-pointed to a surviving file node, or dropped as a self-loop or duplicate. */
  edgesChanged: number;
  /** Rows deleted from the dead index scopes. */
  deadIndexRowsDeleted: number;
  /** Semantic Facts whose strength was recomputed from their idle periods. */
  decayRepaired: number;
  /** Near-duplicate Insights merged into a survivor and deleted. */
  insightsCollapsed: number;
};

const DECAY_REPAIR_MARKER = "decay-repair:done";
const INSIGHT_COLLAPSE_MARKER = "insight-collapse:done";
const DAY_MS = 24 * 60 * 60 * 1000;

function alreadyRan(state: SqliteState): boolean {
  const recorded = state.get(KV.state, MARKER_KEY);
  return typeof recorded === "number" && recorded >= STARTUP_MAINTENANCE_VERSION;
}

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

// Walk a scope a chunk at a time, yielding between chunks. Each call to
// `page` is handed the seq of the last row already handled: a pass that
// rewrites rows in place resumes past them, while a pass that deletes them
// has nothing left to resume past and ignores it.
async function inChunks<T extends { seq: number }>(
  page: (afterSeq: number) => T[],
  handle: (rows: T[]) => void,
): Promise<void> {
  let after = 0;
  for (;;) {
    const rows = page(after);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].seq;
    handle(rows);
    if (rows.length < CHUNK_ROWS) break;
    await yieldToEventLoop();
  }
}

// `field` names the id list inside each row; without it the row is the list.
async function trimIdLists(
  state: SqliteState,
  scope: string,
  max: number,
  field?: string,
): Promise<{ rowsTrimmed: number; idsDropped: number }> {
  // `seq` is the rowid and survives in-place updates, so paging by it is
  // stable even though the trim rewrites rows it has already passed.
  const page = state.db.prepare(
    "SELECT seq, key, value FROM kv WHERE scope = ? AND seq > ? ORDER BY seq LIMIT ?",
  );

  let rowsTrimmed = 0;
  let idsDropped = 0;

  await inChunks(
    (after) =>
      page.all(scope, after, CHUNK_ROWS) as Array<{
        seq: number;
        key: string;
        value: string;
      }>,
    (rows) => {
      const entries: Array<{ key: string; value: unknown }> = [];
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.value);
        } catch {
          continue;
        }
        const ids = field ? (parsed as Record<string, unknown> | null)?.[field] : parsed;
        if (!Array.isArray(ids) || ids.length <= max) continue;
        // The write path's rule, not a second copy of it: dedupe from the
        // tail, keep the newest `max`.
        const capped = capSourceIds(ids as string[], max);
        idsDropped += ids.length - capped.length;
        entries.push({
          key: row.key,
          value: field ? { ...(parsed as object), [field]: capped } : capped,
        });
      }

      if (entries.length > 0) {
        state.setMany(scope, entries);
        rowsTrimmed += entries.length;
      }
    },
  );

  return { rowsTrimmed, idsDropped };
}

// Raw SQL rather than delete() per key: these scopes have no reader left, so
// there is nobody to fire a state:deleted event at, and the row count is only
// known by scanning anyway.
async function deleteDeadIndexRows(state: SqliteState): Promise<number> {
  const pick = state.db.prepare(
    "SELECT seq FROM kv WHERE (scope = ? OR scope LIKE ?) LIMIT ?",
  );
  const like = `${DEAD_INDEX_SCOPE_PREFIX}%`;
  let deleted = 0;

  await inChunks(
    // The rows this read are gone by the next call, so the cursor is moot.
    (_afterSeq) => pick.all(DEAD_INDEX_SCOPE, like, CHUNK_ROWS) as Array<{ seq: number }>,
    (rows) => {
      const seqs = rows.map((row) => row.seq);
      const result = state.db
        .prepare(`DELETE FROM kv WHERE seq IN (${seqs.map(() => "?").join(",")})`)
        .run(...seqs);
      deleted += Number(result.changes ?? 0);
    },
  );

  return deleted;
}

// The decay tier once lowered strength on every run instead of once per idle
// period, flooring facts idle for far fewer periods. Recompute each from its
// confidence (Semantic Facts start at strength = confidence), counting periods
// as applyDecay does, and stamp lastDecayedAt so the corrected value is not
// decayed again for the same periods. A fact re-seen inside its current period
// was floored all the same, so it returns to its confidence. Procedural
// memories record no initial strength, so they are left alone. Runs once,
// whatever the maintenance version.
async function repairDecay(state: SqliteState): Promise<number> {
  if (state.get(KV.config, DECAY_REPAIR_MARKER) !== null) return 0;

  const decayDays = getConsolidationDecayDays();
  const now = Date.now();
  const repairedAt = new Date(now).toISOString();
  const periodMs = decayDays * DAY_MS;
  const page = state.db.prepare(
    "SELECT seq, value FROM kv WHERE scope = ? AND seq > ? ORDER BY seq LIMIT ?",
  );
  const repairedIds: string[] = [];

  if (decayDays > 0 && Number.isFinite(decayDays)) {
    await inChunks(
      (after) => page.all(KV.semantic, after, CHUNK_ROWS) as Array<{ seq: number; value: string }>,
      (rows) => {
        const entries: Array<{ key: string; value: SemanticMemory }> = [];
        for (const row of rows) {
          let fact: SemanticMemory;
          try {
            fact = JSON.parse(row.value) as SemanticMemory;
          } catch {
            continue;
          }
          const reference = new Date(fact.lastAccessedAt || fact.updatedAt).getTime();
          const periods = Math.max(0, Math.floor((now - reference) / periodMs));
          if (!Number.isFinite(periods) || typeof fact.confidence !== "number") continue;
          const strength = decayedStrength(fact.confidence, periods);
          if (periods === 0 && strength === fact.strength) continue;
          entries.push({
            key: fact.id,
            value: {
              ...fact,
              strength,
              ...(periods > 0 && {
                lastDecayedAt: new Date(reference + periods * periodMs).toISOString(),
              }),
            },
          });
        }
        if (entries.length > 0) {
          state.setMany(KV.semantic, entries);
          repairedIds.push(...entries.map((e) => e.key));
        }
      },
    );
  }

  state.set(KV.config, DECAY_REPAIR_MARKER, { at: repairedAt, count: repairedIds.length });
  if (repairedIds.length > 0) {
    const id = generateId("aud");
    state.set(KV.audit, id, {
      id,
      timestamp: repairedAt,
      operation: "consolidate",
      functionId: "startup-maintenance",
      targetIds: [],
      details: { event: "decay.repair", count: repairedIds.length, decayDays },
    });
    logger.info("Decay repaired", { count: repairedIds.length, decayDays });
  }
  return repairedIds.length;
}

// mem::reflect once minted a paraphrase of a cluster's Insight as a new row
// every run. Keep each cluster's strongest INSIGHTS_PER_CLUSTER Insights and
// fold every other into the survivor it overlaps most (reinforcements summed,
// highest confidence, source ids unioned), then delete it. A cluster's merge,
// its deletions and its audit row commit in one transaction, so an
// interrupted pass leaves that cluster untouched and the marker unset: the
// next boot redoes it without counting anything twice. Insights have no
// search index of their own, so deleting the row is all the de-indexing
// there is. Gated by its own marker, not MAINTENANCE_VERSION.
async function collapseInsights(state: SqliteState): Promise<number> {
  if (state.get(KV.config, INSIGHT_COLLAPSE_MARKER) !== null) return 0;

  const page = state.db.prepare(
    "SELECT seq, key, value FROM kv WHERE scope = ? AND seq > ? ORDER BY seq LIMIT ?",
  );
  const clusters = new Map<string, string[]>();
  await inChunks(
    (after) =>
      page.all(KV.insights, after, CHUNK_ROWS) as Array<{ seq: number; key: string; value: string }>,
    (rows) => {
      for (const row of rows) {
        let insight: Insight;
        try {
          insight = JSON.parse(row.value) as Insight;
        } catch {
          continue;
        }
        if (insight.deleted || !Array.isArray(insight.sourceConceptCluster)) continue;
        const key = insightClusterKey(insight.project, insight.sourceConceptCluster);
        const keys = clusters.get(key);
        if (keys) keys.push(row.key);
        else clusters.set(key, [row.key]);
      }
    },
  );

  let collapsed = 0;
  for (const keys of clusters.values()) {
    if (keys.length <= INSIGHTS_PER_CLUSTER) continue;
    const insights = keys
      .map((key) => state.get(KV.insights, key) as Insight | null)
      .filter((i): i is Insight => i !== null)
      .sort(compareSurvivor);

    const survivors = insights
      .slice(0, INSIGHTS_PER_CLUSTER)
      .map((insight) => ({ insight, merged: [] as Insight[] }));
    for (const overflow of insights.slice(INSIGHTS_PER_CLUSTER)) {
      const nearest = nearestInsight(overflow, survivors.map((s) => s.insight));
      survivors.find((s) => s.insight === nearest)!.merged.push(overflow);
    }

    const at = new Date().toISOString();
    state.transaction(() => {
      for (const { insight, merged } of survivors) {
        if (merged.length === 0) continue;
        for (const other of merged) absorbInsight(insight, other);
        insight.updatedAt = at;
        state.set(KV.insights, insight.id, insight);
        for (const other of merged) state.delete(KV.insights, other.id);
        const id = generateId("aud");
        state.set(KV.audit, id, {
          id,
          timestamp: at,
          operation: "delete",
          functionId: "startup-maintenance",
          targetIds: merged.map((m) => m.id),
          details: { event: "insight.collapse", survivor: insight.id, merged: merged.length },
        });
        collapsed += merged.length;
      }
    });
    await yieldToEventLoop();
  }

  state.set(KV.config, INSIGHT_COLLAPSE_MARKER, { at: new Date().toISOString(), count: collapsed });
  if (collapsed > 0) logger.info("Insights collapsed", { count: collapsed });
  return collapsed;
}

async function sessionCheckoutRoots(state: SqliteState): Promise<string[]> {
  const roots = new Set<string>();
  const cwds = new Set(
    (state.list(KV.sessions) as Session[]).flatMap((s) => (s?.cwd ? [s.cwd] : [])),
  );
  for (const cwd of cwds) {
    if ([...roots].some((root) => cwd === root || cwd.startsWith(root + "/"))) continue;
    for (const root of await checkoutRootsOf(cwd)) roots.add(root);
  }
  return [...roots];
}

/**
 * The one-time repair pass: trims graph provenance (nodes, edges and edge history), obs-nodes rows, Insight
 * and Semantic Fact source lists written before their write-time bounds
 * existed, folds duplicate file nodes, reclaims the dead index scopes, then
 * records the version so later boots skip the scan entirely.
 *
 * Chunked and yielding, so the daemon keeps serving while it runs. It takes
 * the open store, which is the seam it is tested at, and touches nothing
 * recallable.
 */
export async function runStartupMaintenance(
  state: SqliteState,
): Promise<StartupMaintenanceResult> {
  const decayRepaired = await repairDecay(state);
  const insightsCollapsed = await collapseInsights(state);

  if (alreadyRan(state)) {
    return {
      skipped: true,
      rowsTrimmed: 0,
      idsDropped: 0,
      fileNodesMerged: 0,
      edgesChanged: 0,
      deadIndexRowsDeleted: 0,
      decayRepaired,
      insightsCollapsed,
    };
  }

  const max = getMaxSourceObservationIds();
  const trimmed = [
    await trimIdLists(state, KV.graphNodes, max, "sourceObservationIds"),
    await trimIdLists(state, KV.graphEdges, max, "sourceObservationIds"),
    await trimIdLists(state, KV.graphEdgeHistory, max, "sourceObservationIds"),
    await trimIdLists(state, KV.graphObsNodes, max),
    await trimIdLists(state, KV.insights, MAX_SOURCE_LIST_IDS, "sourceMemoryIds"),
    await trimIdLists(state, KV.semantic, MAX_SOURCE_LIST_IDS, "sourceSessionIds"),
  ];
  const merged = await mergeDuplicateFileNodes(state, await sessionCheckoutRoots(state));
  const deadIndexRowsDeleted = await deleteDeadIndexRows(state);

  state.set(KV.state, MARKER_KEY, STARTUP_MAINTENANCE_VERSION);

  const result: StartupMaintenanceResult = {
    skipped: false,
    rowsTrimmed: trimmed.reduce((n, t) => n + t.rowsTrimmed, 0),
    idsDropped: trimmed.reduce((n, t) => n + t.idsDropped, 0),
    fileNodesMerged: merged.nodesMerged,
    edgesChanged: merged.edgesChanged,
    deadIndexRowsDeleted,
    decayRepaired,
    insightsCollapsed,
  };

  if (
    result.rowsTrimmed > 0 ||
    result.fileNodesMerged > 0 ||
    result.edgesChanged > 0 ||
    result.deadIndexRowsDeleted > 0
  ) {
    logger.info("Startup maintenance complete", {
      rowsTrimmed: result.rowsTrimmed,
      idsDropped: result.idsDropped,
      fileNodesMerged: result.fileNodesMerged,
      edgesChanged: result.edgesChanged,
      deadIndexRowsDeleted: result.deadIndexRowsDeleted,
      provenanceBound: max,
    });
  }

  return result;
}
