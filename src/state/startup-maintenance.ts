import type { SqliteState } from "../engine/inproc/state.js";
import { KV } from "./schema.js";
import { getMaxSourceObservationIds } from "../config.js";
import { logger } from "../logger.js";
import type { StateScope } from "../types.js";

// Bump when the pass gains a job that has to run against a store an earlier
// version already marked as done.
export const STARTUP_MAINTENANCE_VERSION = 1;

const MARKER_KEY: keyof StateScope = "system:startupMaintenanceVersion";

// The deleted engine's index persistence wrote its manifests into
// `mem:index:bm25` and every shard into its own `mem:index:bm25:<kind>:...`
// scope. Nothing reads either now — BM25 is rebuilt from content at boot and
// vectors live in their own table — and the prefix belongs to that module
// alone, so the whole subtree goes.
const DEAD_INDEX_SCOPE = KV.bm25Index;

export type StartupMaintenanceResult = {
  /** True when an earlier boot already completed this version of the pass. */
  skipped: boolean;
  /** Graph rows whose provenance was over the bound and got trimmed. */
  rowsTrimmed: number;
  /** Source observation ids dropped across all trimmed rows. */
  idsDropped: number;
  /** Rows deleted from the dead index scopes. */
  deadIndexRowsDeleted: number;
};

function alreadyRan(state: SqliteState): boolean {
  const recorded = state.get(KV.state, MARKER_KEY);
  return typeof recorded === "number" && recorded >= STARTUP_MAINTENANCE_VERSION;
}

function trimProvenance(
  state: SqliteState,
  scope: string,
  max: number,
): { rowsTrimmed: number; idsDropped: number } {
  const rows = state.db
    .prepare("SELECT key, value FROM kv WHERE scope = ? ORDER BY seq")
    .all(scope) as Array<{ key: string; value: string }>;

  const entries: Array<{ key: string; value: unknown }> = [];
  let idsDropped = 0;

  for (const row of rows) {
    let parsed: { sourceObservationIds?: unknown };
    try {
      parsed = JSON.parse(row.value) as { sourceObservationIds?: unknown };
    } catch {
      continue;
    }
    const ids = parsed.sourceObservationIds;
    if (!Array.isArray(ids) || ids.length <= max) continue;
    // Same rule the write path applies: ids are appended as observed, so the
    // newest sit at the tail and a tail slice is what survives.
    parsed.sourceObservationIds = ids.slice(ids.length - max);
    idsDropped += ids.length - max;
    entries.push({ key: row.key, value: parsed });
  }

  if (entries.length === 0) return { rowsTrimmed: 0, idsDropped: 0 };
  state.setMany(scope, entries);
  return { rowsTrimmed: entries.length, idsDropped };
}

// Raw SQL rather than delete() per key: these scopes have no reader left, so
// there is nobody to fire a state:deleted event at, and the row count is only
// known by scanning anyway.
function deleteDeadIndexRows(state: SqliteState): number {
  return state.transaction(() => {
    const result = state.db
      .prepare("DELETE FROM kv WHERE scope = ? OR scope LIKE ?")
      .run(DEAD_INDEX_SCOPE, `${DEAD_INDEX_SCOPE}:%`);
    return Number(result.changes ?? 0);
  });
}

/**
 * The one-time repair pass: trims graph provenance written before the
 * write-time bound existed, reclaims the dead index scopes, then records the
 * version so later boots skip the scan entirely.
 *
 * Synchronous and self-contained — it takes the open store, which is the seam
 * it is tested at, and touches nothing recallable.
 */
export function runStartupMaintenance(state: SqliteState): StartupMaintenanceResult {
  if (alreadyRan(state)) {
    return { skipped: true, rowsTrimmed: 0, idsDropped: 0, deadIndexRowsDeleted: 0 };
  }

  const max = getMaxSourceObservationIds();
  const nodes = trimProvenance(state, KV.graphNodes, max);
  const edges = trimProvenance(state, KV.graphEdges, max);
  const deadIndexRowsDeleted = deleteDeadIndexRows(state);

  state.set(KV.state, MARKER_KEY, STARTUP_MAINTENANCE_VERSION);

  const result: StartupMaintenanceResult = {
    skipped: false,
    rowsTrimmed: nodes.rowsTrimmed + edges.rowsTrimmed,
    idsDropped: nodes.idsDropped + edges.idsDropped,
    deadIndexRowsDeleted,
  };

  if (result.rowsTrimmed > 0 || result.deadIndexRowsDeleted > 0) {
    logger.info("Startup maintenance complete", {
      rowsTrimmed: result.rowsTrimmed,
      idsDropped: result.idsDropped,
      deadIndexRowsDeleted: result.deadIndexRowsDeleted,
      provenanceBound: max,
    });
  }

  return result;
}
