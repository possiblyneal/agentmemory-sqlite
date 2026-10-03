import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #91: Eviction's stale-Session recovery holds at most one LLM slot.
// Driven through mem::evict with the real session-stop, Summarize, Graph
// Extraction and reflect handlers; only the provider is fake.

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
}));

import { registerEvictFunction } from "../src/functions/evict.js";
import { registerEventTriggers } from "../src/triggers/events.js";
import { registerSummarizeFunction } from "../src/functions/summarize.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import { registerSlotsFunctions } from "../src/functions/slots.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, MemoryProvider, Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const STALE_AT = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
const OBS_PER_SESSION = 30;
const TOKENS_PER_OBS = 10;
// Matches the chunk packing in test/summarize.test.ts: ten Observations a chunk.
const CHUNK_BUDGET = String(400 + 10 * (TOKENS_PER_OBS + 4));

const SESSIONS: Array<Pick<Session, "id" | "status">> = [
  { id: "ses_a", status: "completed" },
  { id: "ses_b", status: "abandoned" },
  { id: "ses_c", status: "completed" },
];

const ENV = {
  SUMMARIZE_CHUNK_TOKENS: CHUNK_BUDGET,
  SUMMARIZE_CHUNK_CONCURRENCY: "2",
  GRAPH_EXTRACTION_ENABLED: "true",
  AGENTMEMORY_REFLECT: "true",
  CONSOLIDATION_ENABLED: "false",
  AGENTMEMORY_GRAPH_LEG: undefined,
};
const ORIGINAL_ENV = Object.fromEntries(
  Object.keys(ENV).map((k) => [k, process.env[k]]),
);

function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function makeObservation(sessionId: string, i: number): CompressedObservation {
  return {
    id: `obs_${String(i).padStart(2, "0")}`,
    sessionId,
    timestamp: STALE_AT,
    type: "decision",
    title: `${sessionId} decision ${i}`,
    facts: [`fact ${i}`],
    narrative: `narrative ${i}`,
    concepts: ["sqlite"],
    files: [`src/file_${i}.ts`],
    importance: 6,
  };
}

const SUMMARY_XML = `<summary>
<title>Recovered</title>
<narrative>The Session settled on sqlite for local state.</narrative>
<decisions><decision>d</decision></decisions>
<files><file>src/a.ts</file></files>
<concepts><concept>sqlite</concept></concepts>
</summary>`;
const GRAPH_XML = `<entities><entity type="concept" name="sqlite"/></entities>`;

function sessionIn(prompt: string): string {
  return prompt.match(/ses_[a-z]/)?.[0] ?? "unknown";
}

// Records every LLM call, the most in flight at once, and a timeline of
// starts and ends tagged with the Session the prompt belongs to.
function recordingProvider() {
  let inflight = 0;
  const stats = { maxInflight: 0, timeline: [] as string[] };
  const call = async (kind: string, prompt: string, response: string) => {
    inflight += 1;
    stats.maxInflight = Math.max(stats.maxInflight, inflight);
    stats.timeline.push(`start ${kind} ${sessionIn(prompt)}`);
    await new Promise((r) => setTimeout(r, 2));
    inflight -= 1;
    stats.timeline.push(`end ${kind} ${sessionIn(prompt)}`);
    return response;
  };
  const provider: MemoryProvider = {
    name: "test",
    countTokens: async () => TOKENS_PER_OBS,
    compress: (_system, user) => call("graph", user, GRAPH_XML),
    summarize: (_system, user) => call("summarize", user, SUMMARY_XML),
  };
  return { provider, stats };
}

async function setup() {
  const kv = mockKV();
  const sdk = mockSdk();
  // Like the Engine, a void trigger dispatches its handler and resolves at
  // once, so awaiting a fired-and-forgotten call does not wait for it.
  const dispatch = sdk.trigger;
  sdk.trigger = (async (input: Parameters<typeof dispatch>[0], data?: unknown) => {
    if (typeof input === "object" && (input.action as { type?: string })?.type === "void") {
      void dispatch(input).catch(() => {});
      return undefined;
    }
    return dispatch(input, data);
  }) as typeof dispatch;
  for (const { id, status } of SESSIONS) {
    await kv.set(KV.sessions, id, {
      id,
      status,
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      startedAt: STALE_AT,
      observationCount: OBS_PER_SESSION,
    } satisfies Session);
    for (let i = 0; i < OBS_PER_SESSION; i++) {
      const o = makeObservation(id, i);
      await kv.set(KV.observations(id), o.id, o);
    }
  }
  const { provider, stats } = recordingProvider();
  registerEvictFunction(sdk as never, kv as never);
  registerEventTriggers(sdk as never, kv as never);
  registerSummarizeFunction(sdk as never, kv as never, provider);
  registerGraphFunction(sdk as never, kv as never, provider);
  registerSlotsFunctions(sdk as never, kv as never);

  const reflect = sdk.fns.get("mem::slot-reflect")!;
  sdk.fns.set("mem::slot-reflect", async (payload) => {
    const result = await reflect(payload);
    stats.timeline.push(`end reflect ${(payload as { sessionId: string }).sessionId}`);
    return result;
  });

  const evict = () => sdk.trigger({ function_id: "mem::evict", payload: {} });
  return { kv, stats, evict };
}

describe("stale-Session recovery holds one LLM slot", () => {
  beforeEach(() => setEnv(ENV));
  afterEach(() => setEnv(ORIGINAL_ENV));

  it("never has more than one LLM call in flight across a multi-chunk sweep with an Abandoned Session", async () => {
    const { kv, stats, evict } = await setup();

    const result = (await evict()) as { staleSessions: number };

    const summarizeCalls = stats.timeline.filter((e) => e.startsWith("start summarize"));
    for (const { id } of SESSIONS) {
      expect(summarizeCalls.filter((e) => e.endsWith(id)).length).toBeGreaterThan(1);
      expect(stats.timeline).toContain(`end graph ${id}`);
      expect(await kv.get(KV.summaries, id)).not.toBeNull();
      expect(await kv.get(KV.sessions, id)).toBeNull();
    }
    expect(result.staleSessions).toBe(SESSIONS.length);
    expect(stats.maxInflight).toBe(1);
  });

  it("starts a Session's first Summarize only after the previous Session's Graph Extraction and reflect resolve", async () => {
    const { stats, evict } = await setup();

    await evict();

    const at = (event: string) => stats.timeline.indexOf(event);
    for (let i = 1; i < SESSIONS.length; i++) {
      const previous = SESSIONS[i - 1]!.id;
      const next = at(`start summarize ${SESSIONS[i]!.id}`);
      expect(at(`end graph ${previous}`)).toBeGreaterThan(-1);
      expect(at(`end reflect ${previous}`)).toBeGreaterThan(-1);
      expect(next).toBeGreaterThan(stats.timeline.lastIndexOf(`end graph ${previous}`));
      expect(next).toBeGreaterThan(at(`end reflect ${previous}`));
    }
  });
});
