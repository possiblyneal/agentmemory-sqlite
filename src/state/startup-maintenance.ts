import type { SqliteState } from "../engine/inproc/state.js";
import { DEAD_INDEX_SCOPE, DEAD_INDEX_SCOPE_PREFIX, KV } from "./schema.js";
import { capSourceIds, MAX_SOURCE_LIST_IDS } from "../functions/graph-provenance.js";
import { checkoutRootsOf } from "../functions/project-files.js";
import { mergeDuplicateFileNodes } from "./merge-file-nodes.js";
import { getMaxSourceObservationIds } from "../config.js";
import { logger } from "../logger.js";
import type { Session, StateScope } from "../types.js";

// Bump when the pass gains a job that has to run against a store an earlier
// version already marked as done.
export const STARTUP_MAINTENANCE_VERSION = 2;

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
 * The one-time repair pass: trims graph provenance, obs-nodes rows, Insight
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
  if (alreadyRan(state)) {
    return {
      skipped: true,
      rowsTrimmed: 0,
      idsDropped: 0,
      fileNodesMerged: 0,
      edgesChanged: 0,
      deadIndexRowsDeleted: 0,
    };
  }

  const max = getMaxSourceObservationIds();
  const trimmed = [
    await trimIdLists(state, KV.graphNodes, max, "sourceObservationIds"),
    await trimIdLists(state, KV.graphEdges, max, "sourceObservationIds"),
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
