import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSearchFunction, rebuildIndex, getSearchIndex } from "../src/functions/search.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Memory, Session } from "../src/types.js";

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
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      functions.set(typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const TOPIC = "deployment rollback policy";
const SAVED_IDS = [1, 2, 3, 4, 5].map((n) => `mem_saved_${n}`);
const OBSERVATION_COUNT = 1800;

function longMemory(n: number, project: string, id = `mem_saved_${n}`): Memory {
  const filler = "The release owner reviews the checklist and records the outcome in the tracker. ".repeat(60);
  return {
    id,
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    type: "decision",
    title: `Decision ${n}: ${TOPIC}`,
    content: `${TOPIC} number ${n}: roll back on failed health checks. ${filler}`,
    concepts: ["deployment", "rollback"],
    files: [],
    sessionIds: [],
    strength: 7,
    version: 1,
    isLatest: true,
    project,
  };
}

function toolObservation(i: number, sessionId: string): CompressedObservation {
  return {
    id: `obs_tool_${i}`,
    sessionId,
    timestamp: "2026-03-01T00:00:00Z",
    type: "command_run",
    title: `Bash: ${TOPIC} ${TOPIC} check ${i}`,
    facts: [`${TOPIC} step ${i}`],
    narrative: `Ran ${TOPIC} script ${i}`,
    concepts: ["deployment", "rollback", "policy"],
    files: [],
    importance: 3,
  };
}

const SECRET = "burial-secret";

describe("memory_recall burial (#191)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let recall: (args: Record<string, unknown>) => Promise<any>;

  beforeEach(async () => {
    getSearchIndex().clear();
    sdk = mockSdk();
    kv = mockKV();
    registerSearchFunction(sdk as never, kv as never);
    const fns = new Map<string, Function>();
    registerMcpEndpoints(
      {
        registerFunction: (id: string, h: Function) => fns.set(id, h),
        registerTrigger: () => {},
        trigger: sdk.trigger,
      } as never,
      kv as never,
      SECRET,
    );
    recall = async (args) => {
      const res = await fns.get("mcp::tools::call")!({
        headers: { authorization: `Bearer ${SECRET}` },
        body: { name: "memory_recall", arguments: { query: TOPIC, project: "alpha", ...args } },
      });
      return JSON.parse(res.body.content[0].text);
    };

    const session: Session = {
      id: "ses_tools",
      project: "alpha",
      cwd: "/tmp/alpha",
      startedAt: "2026-03-01T00:00:00Z",
      status: "completed",
      observationCount: OBSERVATION_COUNT,
    };
    await kv.set(KV.sessions, session.id, session);
    for (let i = 0; i < OBSERVATION_COUNT; i++) {
      await kv.set(KV.observations(session.id), `obs_tool_${i}`, toolObservation(i, session.id));
    }
    for (let n = 1; n <= 5; n++) {
      await kv.set(KV.memories, `mem_saved_${n}`, longMemory(n, "alpha"));
    }
    await kv.set(KV.memories, "mem_control", longMemory(0, "beta", "mem_control"));
    await rebuildIndex(kv as never);
  });

  it("mixed search buries the saved Memories under the tool Observations", async () => {
    const result = await recall({ limit: 10, format: "compact", targetLayer: "all" });
    const ids = result.results.map((r: { obsId: string }) => r.obsId);
    expect(SAVED_IDS.filter((id) => ids.includes(id))).toEqual([]);
  });

  it("returns every saved Memory of the project and none from the control project", async () => {
    const result = await recall({ limit: 10, format: "compact" });
    const ids = result.results.map((r: { obsId: string }) => r.obsId);
    expect(ids).not.toContain("mem_control");
    expect(SAVED_IDS.filter((id) => !ids.includes(id))).toEqual([]);
  });

  it("shortens the top match under a token budget instead of dropping it", async () => {
    const result = await recall({ limit: 10, token_budget: 300 });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].observation.narrative.length).toBeGreaterThan(0);
    expect(result.tokens_used).toBeLessThanOrEqual(300);
    expect(result.content_truncated).toBe(true);
  });

  it("counts access only for the returned Memories", async () => {
    await recall({ limit: 10, token_budget: 300 });
    await new Promise((r) => setTimeout(r, 20));
    const touched = [] as string[];
    for (const id of SAVED_IDS) {
      const row = await kv.get<{ accessCount?: number }>(KV.accessLog, id);
      if (row) touched.push(id);
    }
    expect(touched).toHaveLength(1);
  });
});
