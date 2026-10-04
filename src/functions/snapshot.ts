import type { ISdk } from "../engine/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  SnapshotMeta,
  Session,
  Memory,
  GraphNode,
  GraphEdge,
  CompressedObservation,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { indexGraphNode, indexGraphEdge } from "../state/graph-indexes.js";
import { capRecordProvenance } from "./graph-provenance.js";
import { graphWritesDisabled } from "./graph.js";
import {
  DURABLE_STORES,
  readDurableStores,
  runChunked,
  type DurableStore,
  type DurableStoreField,
} from "./export-import.js";
import {
  deleteIndexed,
  getSearchIndex,
  indexRecords,
  vectorIndexRemove,
} from "./search.js";
import { resetLessonIndex } from "./lessons.js";
import { recordAudit } from "./audit.js";
import { VERSION } from "../version.js";
import { logger } from "../logger.js";

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

const execFileAsync = promisify(execFile);

async function gitExec(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout.trim();
}

async function ensureGitRepo(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(join(dir, ".git"))) {
    await gitExec(dir, ["init"]);
    await gitExec(dir, ["config", "user.email", "agentmemory@local"]);
    await gitExec(dir, ["config", "user.name", "agentmemory"]);
  }
}

type SnapshotRow = Record<string, unknown>;

type SnapshotState = { [K in DurableStoreField]?: SnapshotRow[] } & {
  observations?: Record<string, SnapshotRow[]>;
};

interface StoreCounts {
  written: number;
  removed: number;
}

async function replaceStore(
  kv: StateKV,
  store: DurableStore,
  rows: SnapshotRow[],
): Promise<StoreCounts> {
  const keep = new Set(rows.map(store.keyOf));
  const existing = await kv.list<SnapshotRow>(store.scope);
  const stale = existing.map(store.keyOf).filter((key) => !keep.has(key));

  await runChunked(stale, (key) =>
    store.field === "memories"
      ? deleteIndexed(kv, store.scope, key)
      : kv.delete(store.scope, key),
  );

  await runChunked(rows, async (row) => {
    if (store.field === "graphNodes") {
      const node = capRecordProvenance(row as unknown as GraphNode);
      await kv.set(store.scope, node.id, node);
      await indexGraphNode(kv, node);
    } else if (store.field === "graphEdges") {
      const edge = capRecordProvenance(row as unknown as GraphEdge);
      await kv.set(store.scope, edge.id, edge);
      await indexGraphEdge(kv, edge);
    } else {
      await kv.set(store.scope, store.keyOf(row), row);
    }
  });

  if (store.field === "memories") {
    const memories = rows as unknown as Memory[];
    for (const memory of memories) {
      if (memory.isLatest === false) {
        getSearchIndex().remove(memory.id);
        vectorIndexRemove(memory.id);
      }
    }
    await indexRecords([], memories);
  }
  if (store.field === "lessons") resetLessonIndex();

  return { written: rows.length, removed: stale.length };
}

async function replaceObservations(
  kv: StateKV,
  snapshot: Record<string, SnapshotRow[]>,
): Promise<StoreCounts> {
  const sessionIds = new Set([
    ...(await kv.list<Session>(KV.sessions)).map((s) => s.id),
    ...Object.keys(snapshot),
  ]);
  let written = 0;
  let removed = 0;

  for (const sessionId of sessionIds) {
    const scope = KV.observations(sessionId);
    const rows = (snapshot[sessionId] ?? []) as unknown as CompressedObservation[];
    const keep = new Set(rows.map((o) => o.id));
    const existing = await kv.list<CompressedObservation>(scope);
    const stale = existing.filter((o) => !keep.has(o.id));
    await runChunked(stale, (o) => deleteIndexed(kv, scope, o.id));
    removed += stale.length;
    await runChunked(rows, async (o) => {
      await kv.set(scope, o.id, o);
    });
    await indexRecords(rows, []);
    written += rows.length;
  }

  return { written, removed };
}

export function registerSnapshotFunction(
  sdk: ISdk,
  kv: StateKV,
  snapshotDir: string,
): void {
  // Serialize snapshots: the periodic timer, REST (api::snapshot-create), and
  // MCP can all trigger this concurrently. Two runs writing state.json and
  // committing in the same git repo at once race on the index lock. An
  // overlapping call is a no-op success; the winner captures current state.
  let snapshotInFlight = false;

  sdk.registerFunction("mem::snapshot-create",
    async (data?: { message?: string }) => {
      if (snapshotInFlight) {
        return { success: true, message: "Snapshot already in progress" };
      }
      snapshotInFlight = true;

      try {
        await ensureGitRepo(snapshotDir);
        const ts = new Date().toISOString();

        // A store's key is present (possibly empty) exactly when it was
        // captured; restore treats a missing key as "not captured".
        const stores = await readDurableStores(kv);
        const sessions = stores.sessions ?? [];

        const observations: Record<string, unknown[]> = {};
        for (const session of sessions) {
          const obs = await kv.list(KV.observations(session.id));
          if (obs.length > 0) {
            observations[session.id] = obs;
          }
        }

        const state = {
          version: VERSION,
          timestamp: ts,
          ...stores,
          observations,
        };

        writeFileSync(
          join(snapshotDir, "state.json"),
          JSON.stringify(state, null, 2),
          "utf-8",
        );

        await gitExec(snapshotDir, ["add", "."]);

        const message = data?.message || `Snapshot ${ts}`;
        try {
          await gitExec(snapshotDir, ["commit", "-m", message]);
        } catch (commitErr) {
          const errMsg =
            commitErr instanceof Error ? commitErr.message : String(commitErr);
          if (errMsg.includes("nothing to commit")) {
            return { success: true, message: "No changes to snapshot" };
          }
          throw commitErr;
        }

        const commitHash = await gitExec(snapshotDir, ["rev-parse", "HEAD"]);

        const meta: SnapshotMeta = {
          id: generateId("snap"),
          commitHash,
          createdAt: ts,
          message,
          stats: {
            sessions: sessions.length,
            observations: Object.values(observations).reduce(
              (sum, arr) => sum + arr.length,
              0,
            ),
            memories: stores.memories?.length ?? 0,
            graphNodes: stores.graphNodes?.length ?? 0,
          },
        };

        await recordAudit(kv, "export", "mem::snapshot-create", [meta.id], {
          commitHash,
          stats: meta.stats,
        });

        logger.info("Snapshot created", { commitHash });
        return { success: true, snapshot: meta };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Snapshot failed", { error: msg });
        return { success: false, error: msg };
      } finally {
        snapshotInFlight = false;
      }
    },
  );

  sdk.registerFunction("mem::snapshot-list",  async () => {
    try {
      if (!existsSync(join(snapshotDir, ".git"))) {
        return { snapshots: [] };
      }
      const log = await gitExec(snapshotDir, [
        "log",
        "--format=%H|%aI|%s",
        "-20",
      ]);
      const snapshots = log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|");
          const [hash, date] = parts;
          const msg = parts.slice(2).join("|");
          return { commitHash: hash, createdAt: date, message: msg };
        });
      return { snapshots };
    } catch {
      return { snapshots: [] };
    }
  });

  sdk.registerFunction("mem::snapshot-restore", 
    async (data: { commitHash: string } | undefined) => {
      if (!data || typeof data.commitHash !== "string" || !data.commitHash.trim()) {
        return { success: false, error: "commitHash is required" };
      }
      if (!COMMIT_HASH_RE.test(data.commitHash)) {
        return { success: false, error: "Invalid commitHash format" };
      }

      try {
        await gitExec(snapshotDir, [
          "checkout",
          data.commitHash,
          "--",
          "state.json",
        ]);
        const content = readFileSync(join(snapshotDir, "state.json"), "utf-8");
        const state = JSON.parse(content) as SnapshotState;

        const counts: Record<string, StoreCounts> = {};
        const notCaptured: string[] = [];
        const skipped: string[] = [];

        // Observations first: their scopes are found through the Sessions
        // that exist before the sessions store is replaced.
        if (state.observations) {
          counts.observations = await replaceObservations(kv, state.observations);
        } else {
          notCaptured.push("observations");
        }
        // Snapshots written before graphEdges was captured stored
        // `graphNodes: []` to mean "not enumerated", and replacing nodes
        // alone would leave stale Relations behind: restore the graph only
        // when both stores are present.
        const graphCaptured = "graphNodes" in state && "graphEdges" in state;
        for (const store of DURABLE_STORES) {
          const rows = state[store.field];
          if (!Array.isArray(rows) || (store.graph && !graphCaptured)) {
            notCaptured.push(store.field);
          } else if (store.graph && graphWritesDisabled()) {
            skipped.push(store.field);
          } else {
            counts[store.field] = await replaceStore(kv, store, rows);
          }
        }

        await gitExec(snapshotDir, ["checkout", "HEAD", "--", "state.json"]);

        await recordAudit(kv, "import", "mem::snapshot-restore", [], {
          commitHash: data.commitHash,
          counts,
          notCaptured,
          skipped,
        });

        logger.info("Snapshot restored", {
          commitHash: data.commitHash,
        });
        return {
          success: true,
          commitHash: data.commitHash,
          counts,
          notCaptured,
          skipped,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Snapshot restore failed", { error: msg });
        return { success: false, error: msg };
      }
    },
  );
}
