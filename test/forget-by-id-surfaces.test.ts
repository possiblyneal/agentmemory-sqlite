import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

import { registerRememberFunction } from "../src/functions/remember.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { getSearchIndex } from "../src/functions/search.js";
import { memoryToObservation } from "../src/state/memory-utils.js";
import { KV } from "../src/state/schema.js";
import type { Memory } from "../src/types.js";

// Removing exactly one memory or one observation has to be reachable from
// every surface that can see it. Before this, MCP could only delete
// memories (memory_governance_delete) and the obvious REST route for a
// single memory was unrouted, which reads as "this system cannot forget
// one thing" and pushes an operator onto the filter-based bulk delete.

const SECRET = "forget-test-secret";

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
    update: async () => {},
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
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

function makeMemory(id: string): Memory {
  return {
    id,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    type: "fact",
    title: `title ${id}`,
    content: `content ${id}`,
    concepts: [],
    files: [],
    sessionIds: ["ses_1"],
    strength: 5,
    version: 1,
    isLatest: true,
  };
}

type Surfaces = {
  sdk: ReturnType<typeof mockSdk>;
  kv: ReturnType<typeof mockKV>;
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ status_code: number; body: Record<string, unknown> }>;
  deleteMemory: (
    id: string,
  ) => Promise<{ status_code: number; body: Record<string, unknown> }>;
  postForget: (
    body: Record<string, unknown>,
  ) => Promise<{ status_code: number; body: Record<string, unknown> }>;
};

function surfaces(): Surfaces {
  const kv = mockKV();
  const sdk = mockSdk();
  registerRememberFunction(sdk as never, kv as never);
  registerApiTriggers(sdk as never, kv as never, SECRET);
  registerMcpEndpoints(sdk as never, kv as never, SECRET);
  return {
    sdk,
    kv,
    callTool: (name, args) =>
      sdk._fns.get("mcp::tools::call")!({
        headers: { authorization: `Bearer ${SECRET}` },
        body: { name, arguments: args },
      }),
    deleteMemory: (id) =>
      sdk._fns.get("api::memory-delete")!({
        headers: { authorization: `Bearer ${SECRET}` },
        path_params: { id },
      }),
    postForget: (body) =>
      sdk._fns.get("api::forget")!({
        headers: { authorization: `Bearer ${SECRET}` },
        body,
      }),
  };
}

function toolResult(body: Record<string, unknown>): Record<string, unknown> {
  const content = body.content as Array<{ text: string }>;
  return JSON.parse(content[0].text);
}

async function auditRows(kv: ReturnType<typeof mockKV>) {
  return kv.list<{ operation: string; targetIds: string[]; details: Record<string, unknown> }>(
    KV.audit,
  );
}

describe("memory_forget MCP tool", () => {
  beforeEach(() => {
    getSearchIndex().clear();
  });

  it("removes one memory by id, from search as well as the store", async () => {
    const { kv, callTool } = surfaces();
    const mem = makeMemory("mem_a");
    await kv.set(KV.memories, mem.id, mem);
    getSearchIndex().add(memoryToObservation(mem));

    const res = await callTool("memory_forget", { memoryId: "mem_a" });

    expect(res.status_code).toBe(200);
    expect(toolResult(res.body).deleted).toBe(1);
    expect(await kv.get(KV.memories, "mem_a")).toBeNull();
    expect(getSearchIndex().has("mem_a")).toBe(false);
    const [row] = await auditRows(kv);
    expect(row.operation).toBe("forget");
    expect(row.targetIds).toEqual(["mem_a"]);
  });

  it("removes named observations by id and leaves the session's others", async () => {
    const { kv, callTool } = surfaces();
    await kv.set(KV.observations("ses_1"), "obs_a", { id: "obs_a" });
    await kv.set(KV.observations("ses_1"), "obs_b", { id: "obs_b" });
    getSearchIndex().add(memoryToObservation(makeMemory("obs_a")));
    getSearchIndex().add(memoryToObservation(makeMemory("obs_b")));

    const res = await callTool("memory_forget", {
      sessionId: "ses_1",
      observationIds: "obs_a",
    });

    expect(toolResult(res.body).deleted).toBe(1);
    expect(await kv.get(KV.observations("ses_1"), "obs_a")).toBeNull();
    expect(await kv.get(KV.observations("ses_1"), "obs_b")).not.toBeNull();
    expect(getSearchIndex().has("obs_a")).toBe(false);
    expect(getSearchIndex().has("obs_b")).toBe(true);
    const [row] = await auditRows(kv);
    expect(row.details.observationsDeleted).toBe(1);
  });

  it("reports zero rather than failing for ids that are not there", async () => {
    const { kv, callTool } = surfaces();
    await kv.set(KV.observations("ses_1"), "obs_a", { id: "obs_a" });

    const res = await callTool("memory_forget", {
      sessionId: "ses_1",
      observationIds: "obs_a,obs_never_existed",
    });

    expect(res.status_code).toBe(200);
    // One record was actually removed, so one is what the caller is told.
    expect(toolResult(res.body).deleted).toBe(1);
  });

  it("refuses a call that names nothing to forget", async () => {
    const { callTool } = surfaces();

    const res = await callTool("memory_forget", {});

    expect(res.status_code).toBe(400);
  });

  // Observation ids are only ever looked up inside a session, so a call
  // that omits the session would report success while the observations
  // it named are still there.
  it("refuses observation ids with no session to look them up in", async () => {
    const { kv, callTool } = surfaces();
    await kv.set(KV.observations("ses_1"), "obs_a", { id: "obs_a" });

    const res = await callTool("memory_forget", { observationIds: "obs_a" });

    expect(res.status_code).toBe(400);
    expect(await kv.get(KV.observations("ses_1"), "obs_a")).not.toBeNull();
  });

  it("refuses a memory and a session in one call", async () => {
    const { callTool } = surfaces();

    const res = await callTool("memory_forget", {
      memoryId: "mem_a",
      sessionId: "ses_1",
    });

    expect(res.status_code).toBe(400);
  });
});

describe("POST /agentmemory/forget", () => {
  beforeEach(() => {
    getSearchIndex().clear();
  });

  // An id list the handler cannot read must not decay into "no ids named",
  // which is the whole-session wipe.
  it("refuses a malformed id list rather than wiping the session", async () => {
    const { kv, postForget } = surfaces();
    await kv.set(KV.sessions, "ses_1", { id: "ses_1" });
    await kv.set(KV.observations("ses_1"), "obs_a", { id: "obs_a" });

    const res = await postForget({ sessionId: "ses_1", observationIds: [123] });

    expect(res.status_code).toBe(400);
    expect(await kv.get(KV.sessions, "ses_1")).not.toBeNull();
    expect(await kv.get(KV.observations("ses_1"), "obs_a")).not.toBeNull();
  });

  it("answers 400, not 200, when the call names both a memory and a session", async () => {
    const { postForget } = surfaces();

    const res = await postForget({ memoryId: "mem_a", sessionId: "ses_1" });

    expect(res.status_code).toBe(400);
  });
});

describe("mem::forget session branch", () => {
  beforeEach(() => {
    getSearchIndex().clear();
  });

  it("counts only the session records that were actually there", async () => {
    const { kv, sdk } = surfaces();
    await kv.set(KV.sessions, "ses_1", { id: "ses_1" });

    const result = (await sdk.trigger({
      function_id: "mem::forget",
      payload: { sessionId: "ses_1" },
    })) as { deleted: number };

    // The session existed, its summary never did.
    expect(result.deleted).toBe(1);
  });

  it("reports nothing removed for a session that does not exist", async () => {
    const { kv, sdk } = surfaces();

    const result = (await sdk.trigger({
      function_id: "mem::forget",
      payload: { sessionId: "ses_never_existed" },
    })) as { deleted: number };

    expect(result.deleted).toBe(0);
    expect(await auditRows(kv)).toHaveLength(0);
  });
});

describe("DELETE /agentmemory/memories/:id", () => {
  beforeEach(() => {
    getSearchIndex().clear();
  });

  it("forgets the memory the route names", async () => {
    const { kv, deleteMemory } = surfaces();
    const mem = makeMemory("mem_a");
    await kv.set(KV.memories, mem.id, mem);
    getSearchIndex().add(memoryToObservation(mem));

    const res = await deleteMemory("mem_a");

    expect(res.status_code).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(await kv.get(KV.memories, "mem_a")).toBeNull();
    expect(getSearchIndex().has("mem_a")).toBe(false);
    expect(await auditRows(kv)).toHaveLength(1);
  });

  it("answers with a count of zero for an id that does not exist", async () => {
    const { kv, deleteMemory } = surfaces();

    const res = await deleteMemory("mem_never_existed");

    expect(res.status_code).toBe(200);
    expect(res.body.deleted).toBe(0);
    expect(await auditRows(kv)).toHaveLength(0);
  });

  it("rejects an unauthenticated call", async () => {
    const { sdk } = surfaces();

    const res = await sdk._fns.get("api::memory-delete")!({
      headers: {},
      path_params: { id: "mem_a" },
    });

    expect(res.status_code).toBe(401);
  });
});
