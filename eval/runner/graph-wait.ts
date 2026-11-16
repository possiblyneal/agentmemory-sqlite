import { DatabaseSync } from "node:sqlite";
import { KV } from "../../src/state/schema.js";

export interface GraphCounts {
  nodes: number;
  edges: number;
  obsNodes: number;
  indexesReady: boolean;
}

// The sandbox daemon writes the graph only when extraction is on and the graph
// leg is not killed, so a run with either off has nothing to wait for.
export function graphWaitWanted(env: Record<string, string | undefined>): boolean {
  return env.GRAPH_EXTRACTION_ENABLED === "true" && env.AGENTMEMORY_GRAPH_LEG !== "off";
}

const GRAPH_SCOPES = [KV.graphNodes, KV.graphEdges, KV.graphObsNodes, KV.graphIndexMeta];

function readGraph<T>(sqlitePath: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export function graphCounts(sqlitePath: string): GraphCounts {
  return readGraph(sqlitePath, (db) => {
    const count = (scope: string) =>
      (db.prepare("SELECT COUNT(*) AS n FROM kv WHERE scope = ?").get(scope) as { n: number }).n;
    return {
      nodes: count(KV.graphNodes),
      edges: count(KV.graphEdges),
      obsNodes: count(KV.graphObsNodes),
      indexesReady: count(KV.graphIndexMeta) > 0,
    };
  });
}

// An LLM sandbox summarizes each Session at its stop, before the stop extracts
// its graph, so a Summary row is the sign the stop has run to the end of that
// step. An arm that skips the wait would be searched with fewer Summaries than
// one that waits for its graph.
export function hasSummary(sqlitePath: string, sessionId: string): boolean {
  return readGraph(sqlitePath, (db) => db.prepare("SELECT 1 FROM kv WHERE scope = ? AND key = ?").get(KV.summaries, sessionId) !== undefined);
}

function graphSignature(sqlitePath: string): string {
  return readGraph(sqlitePath, (db) => {
    const marks = GRAPH_SCOPES.map(() => "?").join(",");
    const row = db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS t FROM kv WHERE scope IN (${marks})`)
      .get(...GRAPH_SCOPES) as { n: number; t: number };
    return `${row.n}:${row.t}`;
  });
}

// A Memory saved through /remember is extracted fire-and-forget with no
// Session watermark to wait on, so the graph is settled once its rows stop
// changing. Heuristic extraction takes milliseconds; an LLM extraction is
// awaited through its Session's watermark instead (replay-derived.ts).
export async function waitForGraphQuiet(
  sqlitePath: string,
  opts: { pollMs?: number; quietPolls?: number } = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 1000;
  const quietPolls = opts.quietPolls ?? 5;
  let last = graphSignature(sqlitePath);
  let quiet = 0;
  while (quiet < quietPolls) {
    await new Promise((r) => setTimeout(r, pollMs));
    const now = graphSignature(sqlitePath);
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }
}
