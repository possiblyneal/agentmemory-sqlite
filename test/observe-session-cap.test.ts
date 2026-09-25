import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerObserveFunction } from "../src/functions/observe.js";
import { getSearchIndex } from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";

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
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, fn: Function) => fns.set(id, fn),
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload) ?? null,
  };
}

const SESSION = "ses_cap";

function stored(id: string, importance: number | undefined, timestamp: string) {
  return {
    id,
    sessionId: SESSION,
    timestamp,
    title: `obs ${id}`,
    type: "file_read",
    facts: [],
    narrative: "",
    concepts: [],
    files: [],
    ...(importance === undefined ? {} : { importance }),
  };
}

async function setup(rows: ReturnType<typeof stored>[], cap: number) {
  const kv = mockKV();
  const sdk = mockSdk();
  for (const r of rows) await kv.set(KV.observations(SESSION), r.id, r);
  registerObserveFunction(sdk as never, kv as never, undefined, cap);
  const result = (await sdk.trigger({
    function_id: "mem::observe",
    payload: {
      sessionId: SESSION,
      hookType: "post_tool_use",
      timestamp: "2026-05-01T00:00:00Z",
      data: { tool_name: "Read", tool_input: { file_path: "new.ts" } },
    },
  })) as { observationId?: string; success?: boolean };
  const ids = (await kv.list<{ id: string }>(KV.observations(SESSION))).map((o) => o.id);
  return { result, ids, kv };
}

describe("mem::observe at MAX_OBS_PER_SESSION (PR#1174)", () => {
  it("admits the new observation by evicting the least important one", async () => {
    const { result, ids, kv } = await setup(
      [
        stored("keep", 8, "2026-01-01T00:00:00Z"),
        stored("drop", 2, "2026-01-02T00:00:00Z"),
        stored("raw", undefined, "2026-01-03T00:00:00Z"),
      ],
      3,
    );
    expect(result.observationId).toBeTruthy();
    expect(ids).toHaveLength(3);
    expect(ids).toContain("keep");
    expect(ids).toContain("raw");
    expect(ids).not.toContain("drop");
    const audits = await kv.list<{ operation: string; functionId: string; targetIds: string[] }>(KV.audit);
    expect(audits).toContainEqual(
      expect.objectContaining({ operation: "delete", functionId: "mem::observe", targetIds: ["drop"] }),
    );
  });

  it("evicts the older row on an importance tie and drops it from search", async () => {
    getSearchIndex().add(stored("older", 5, "2026-01-01T00:00:00Z") as never);
    const { ids } = await setup(
      [stored("older", 5, "2026-01-01T00:00:00Z"), stored("newer", 5, "2026-01-02T00:00:00Z")],
      2,
    );
    expect(ids).not.toContain("older");
    expect(ids).toContain("newer");
    expect(getSearchIndex().has("older")).toBe(false);
  });

  it("evicts nothing under the cap", async () => {
    const { ids } = await setup([stored("a", 1, "2026-01-01T00:00:00Z")], 3);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("a");
  });
});
