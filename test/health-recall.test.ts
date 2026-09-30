import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { initMetrics, getCounters } from "../src/telemetry/setup.js";
import {
  registerSmartSearchFunction,
  resetFollowupStatsForTests,
  flushPendingFollowups,
} from "../src/functions/smart-search.js";
import type { HybridSearchResult } from "../src/types.js";

const SECRET = "recall-test-secret";
const auth = { authorization: `Bearer ${SECRET}` };

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function hit(id: string): HybridSearchResult {
  return {
    observation: {
      id,
      sessionId: "s1",
      timestamp: new Date().toISOString(),
      title: id,
      narrative: "n",
      type: "pattern",
      concepts: [],
      files: [],
    },
    sessionId: "s1",
    combinedScore: 0.8,
  } as unknown as HybridSearchResult;
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, h: Function) => {
      fns.set(id, h);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload),
    _fns: fns,
  };
}

let sdk: ReturnType<typeof mockSdk>;
let nextContext = "";
let searchHits: HybridSearchResult[] = [];

async function recall() {
  const res = await sdk._fns.get("api::health")!({ headers: auth });
  return res.body.recall;
}

beforeEach(() => {
  initMetrics();
  resetFollowupStatsForTests();
  sdk = mockSdk();
  const kv = mockKV();
  registerApiTriggers(sdk as never, kv as never, SECRET);
  registerSmartSearchFunction(sdk as never, kv as never, async () => searchHits);
  sdk._fns.set("mem::lesson-recall", () => ({ success: true, lessons: [] }));
  sdk._fns.set("mem::enrich", () => ({ context: nextContext, truncated: false }));
  sdk._fns.set("mem::context", () => ({ context: nextContext }));
});

afterEach(() => {
  delete process.env.AGENTMEMORY_GRAPH_LEG;
});

describe("/health recall counts", () => {
  it("starts at zero", async () => {
    expect(await recall()).toEqual({
      injections: 0,
      emptyInjections: 0,
      smartSearches: 0,
      smartSearchFollowups: 0,
      nonlatestLeaked: 0,
      graphLegOmitted: 0,
      graphLegExpected: true,
    });
  });

  it("counts an Injection at each hook endpoint and an Empty Injection when nothing was found", async () => {
    nextContext = "remembered";
    await sdk._fns.get("api::enrich")!({
      headers: auth,
      body: { sessionId: "s1", files: ["a.ts"], project: "p" },
    });
    nextContext = "";
    await sdk._fns.get("api::context")!({
      headers: auth,
      body: { sessionId: "s1", project: "p" },
    });
    await sdk._fns.get("api::session::start")!({
      headers: auth,
      body: { sessionId: "s2", project: "p", cwd: "/p" },
    });

    const r = await recall();
    expect(r.injections).toBe(3);
    expect(r.emptyInjections).toBe(2);
  });

  it("counts smart-searches, zero-overlap follow-ups and graph-leg omissions", async () => {
    searchHits = [hit("obs_a")];
    await sdk.trigger({ function_id: "mem::smart-search", payload: { query: "auth flow", sessionId: "s1" } });
    await flushPendingFollowups();
    searchHits = [hit("obs_b")];
    await sdk.trigger({ function_id: "mem::smart-search", payload: { query: "token expiry", sessionId: "s1" } });
    await flushPendingFollowups();

    const r = await recall();
    expect(r.smartSearches).toBe(2);
    expect(r.smartSearchFollowups).toBe(1);
    expect(r.graphLegOmitted).toBe(2);
  });

  it("reports stale leaks and graph-leg omissions from their counters", async () => {
    getCounters().nonlatestLeaked.add(2);
    getCounters().graphLegOmitted.add(1);
    const r = await recall();
    expect(r.nonlatestLeaked).toBe(2);
    expect(r.graphLegOmitted).toBe(1);
  });

  it("does not expect the graph leg when it is switched off", async () => {
    process.env.AGENTMEMORY_GRAPH_LEG = "off";
    expect((await recall()).graphLegExpected).toBe(false);
  });
});
