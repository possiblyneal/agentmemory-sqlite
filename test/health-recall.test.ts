import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { initMetrics, getCounters } from "../src/telemetry/setup.js";
import { resetFollowupStatsForTests } from "../src/functions/smart-search.js";

const SECRET = "recall-test-secret";
const auth = { authorization: `Bearer ${SECRET}` };

function mockKV() {
  return {
    get: async () => null,
    set: async <T>(_scope: string, _key: string, data: T) => data,
    delete: async () => {},
    list: async () => [],
  };
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

async function recall() {
  const res = await sdk._fns.get("api::health")!({ headers: auth });
  return res.body.recall;
}

beforeEach(() => {
  initMetrics();
  resetFollowupStatsForTests();
  sdk = mockSdk();
  registerApiTriggers(sdk as never, mockKV() as never, SECRET);
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
