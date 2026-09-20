import type { SqliteState } from "../engine/inproc/state.js";
import { DEAD_INDEX_SCOPE, DEAD_INDEX_SCOPE_PREFIX, KV } from "./schema.js";
import { capSourceIds } from "../functions/graph-provenance.js";
import { getMaxSourceObservationIds } from "../config.js";
import { logger } from "../logger.js";
import type { StateScope } from "../types.js";

// Bump when the pass gains a job that has to run against a store an earlier
// version already marked as done.
export const STARTUP_MAINTENANCE_VERSION = 1;

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

async function trimProvenance(
  state: SqliteState,
  scope: string,
  max: number,
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
        let parsed: { sourceObservationIds?: unknown };
        try {
          parsed = JSON.parse(row.value) as { sourceObservationIds?: unknown };
        } catch {
          continue;
        }
        const ids = parsed.sourceObservationIds;
        if (!Array.isArray(ids) || ids.length <= max) continue;
        // The write path's rule, not a second copy of it: dedupe from the
        // tail, keep the newest `max`.
        const capped = capSourceIds(ids as string[], max);
        parsed.sourceObservationIds = capped;
        idsDropped += ids.length - capped.length;
        entries.push({ key: row.key, value: parsed });
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

/**
 * The one-time repair pass: trims graph provenance written before the
 * write-time bound existed, reclaims the dead index scopes, then records the
 * version so later boots skip the scan entirely.
 *
 * Chunked and yielding, so the daemon keeps serving while it runs. It takes
 * the open store, which is the seam it is tested at, and touches nothing
 * recallable.
 */
export async function runStartupMaintenance(
  state: SqliteState,
): Promise<StartupMaintenanceResult> {
  if (alreadyRan(state)) {
    return { skipped: true, rowsTrimmed: 0, idsDropped: 0, deadIndexRowsDeleted: 0 };
  }

  const max = getMaxSourceObservationIds();
  const nodes = await trimProvenance(state, KV.graphNodes, max);
  const edges = await trimProvenance(state, KV.graphEdges, max);
  const deadIndexRowsDeleted = await deleteDeadIndexRows(state);

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
