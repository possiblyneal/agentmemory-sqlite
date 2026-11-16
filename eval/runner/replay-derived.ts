import { DatabaseSync } from "node:sqlite";
import { isAwaitingCompression } from "../../src/functions/compress-synthetic.js";
import { KV } from "../../src/state/schema.js";
import type { CompressedObservation, Session } from "../../src/types.js";
import { daemonCall } from "./daemon-http.js";

// --derived: after a Session's /session/end, wait for the Semantic Facts and
// graph the live daemon builds from it, so the checkpoint taken after holds
// them. The stop fires graph extraction and consolidation fire-and-forget.
//
// Graph, only when the shell sets GRAPH_EXTRACTION_ENABLED=true (the sandbox
// forwards it): the stop's own extraction is awaited through its watermark
// (`graphExtractedThrough`) rather than repeated by an explicit call, so no
// Observation is extracted twice and the daemon's batching, retry and skip
// rules run as live.
// Consolidation: the stop's own is made never due (a cooldown no clock
// reaches) and the runner drives exactly one pass per Session, which it can
// await.

// Above any epoch millisecond count, so the stop never finds a pass due.
export const NEVER_DUE_COOLDOWN_MS = "9007199254740991";

const CONSOLIDATE_TIMEOUT_MS = 60 * 60_000;
// The watermark moves only when a Session's whole extraction lands, so this bounds
// the extraction itself: one Session's batches ran past 15 minutes on the broker.
const GRAPH_STALL_MS = 2 * 60 * 60_000;
const GRAPH_POLL_MS = 500;

type Stamped = Pick<CompressedObservation, "timestamp" | "title"> & Partial<Pick<CompressedObservation, "awaitingCompression">>;

export function graphExtractionSettled(watermark: string | undefined, observations: Stamped[]): boolean {
  const last = observations
    .filter((o) => !isAwaitingCompression(o as CompressedObservation))
    .reduce<string | undefined>((max, o) => (max === undefined || o.timestamp > max ? o.timestamp : max), undefined);
  return last === undefined || (watermark !== undefined && watermark >= last);
}

export function consolidationFailed(reply: { success?: boolean }): boolean {
  return reply.success !== true;
}

export async function waitUntilSettled(
  read: () => Promise<{ settled: boolean; progress: string }>,
  opts: { stallMs: number; pollMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<"settled" | "stalled"> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let progress: string | undefined;
  let progressAt = now();
  for (;;) {
    const state = await read();
    if (state.settled) return "settled";
    if (state.progress !== progress) {
      progress = state.progress;
      progressAt = now();
    } else if (now() - progressAt >= opts.stallMs) {
      return "stalled";
    }
    await sleep(opts.pollMs);
  }
}

function sessionWatermark(sqlitePath: string, sessionId: string): string | undefined {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM kv WHERE scope = ? AND key = ?").get(KV.sessions, sessionId) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Session).graphExtractedThrough : undefined;
  } finally {
    db.close();
  }
}

export function waitForGraphExtraction(baseUrl: string, sqlitePath: string, sessionId: string): Promise<"settled" | "stalled"> {
  return waitUntilSettled(
    async () => {
      const { body } = await daemonCall<{ observations?: CompressedObservation[] }>(
        baseUrl,
        `observations?sessionId=${encodeURIComponent(sessionId)}`,
      );
      const watermark = sessionWatermark(sqlitePath, sessionId);
      return { settled: graphExtractionSettled(watermark, body.observations ?? []), progress: watermark ?? "" };
    },
    { stallMs: GRAPH_STALL_MS, pollMs: GRAPH_POLL_MS },
  );
}

export async function deriveFactsAndGraph(
  baseUrl: string,
  sqlitePath: string,
  sessionId: string,
  graphEnabled: boolean,
): Promise<{ graph: "off" | "settled" | "stalled"; consolidated: boolean }> {
  const graph = !graphEnabled ? "off" : await waitForGraphExtraction(baseUrl, sqlitePath, sessionId);
  let consolidated = false;
  try {
    const { body } = await daemonCall<{ success?: boolean }>(baseUrl, "consolidate-pipeline", {
      body: { tier: "all" },
      timeoutMs: CONSOLIDATE_TIMEOUT_MS,
    });
    consolidated = !consolidationFailed(body);
  } catch (err) {
    console.warn(`  consolidate-pipeline failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { graph, consolidated };
}
