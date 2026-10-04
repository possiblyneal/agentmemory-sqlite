import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerObserveFunction } from "../src/functions/observe.js";
import { logger } from "../src/logger.js";
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
    update: async (
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value?: unknown }>,
    ): Promise<unknown> => {
      const row = store.get(scope)?.get(key) as Record<string, unknown>;
      for (const op of ops) {
        if (op.type === "set") row[op.path] = op.value;
        else delete row[op.path];
      }
      return row;
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

  it("warns once per Session however many evictions follow", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    const sessionId = "ses_cap_warn";
    await kv.set(KV.observations(sessionId), "seed", { ...stored("seed", 5, "2026-01-01T00:00:00Z"), sessionId });
    registerObserveFunction(sdk as never, kv as never, undefined, 1);
    vi.mocked(logger.warn).mockClear();

    for (const file of ["a.ts", "b.ts", "c.ts"]) {
      await sdk.trigger({
        function_id: "mem::observe",
        payload: {
          sessionId,
          hookType: "post_tool_use",
          timestamp: "2026-05-01T00:00:00Z",
          data: { tool_name: "Read", tool_input: { file_path: file } },
        },
      });
    }

    const capWarns = vi.mocked(logger.warn).mock.calls.filter((c) => String(c[0]).startsWith("Session observation cap reached"));
    expect(capWarns).toHaveLength(1);
  });

  it("keeps the Session's count equal to its rows when the cap evicts", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    const rows = [
      stored("a", 2, "2026-01-01T00:00:00Z"),
      stored("b", 5, "2026-01-02T00:00:00Z"),
      stored("c", 8, "2026-01-03T00:00:00Z"),
    ];
    for (const r of rows) await kv.set(KV.observations(SESSION), r.id, r);
    await kv.set(KV.sessions, SESSION, {
      id: SESSION,
      project: "p",
      cwd: "/p",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 3,
    });
    registerObserveFunction(sdk as never, kv as never, undefined, 2);

    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        sessionId: SESSION,
        hookType: "post_tool_use",
        timestamp: "2026-05-01T00:00:00Z",
        data: { tool_name: "Read", tool_input: { file_path: "new.ts" } },
      },
    });

    expect(await kv.list(KV.observations(SESSION))).toHaveLength(2);
    expect(await kv.get(KV.sessions, SESSION)).toMatchObject({ observationCount: 2 });
  });

  it("evicts nothing when the new row's write fails on a full disk", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    for (const r of [stored("a", 2, "2026-01-01T00:00:00Z"), stored("b", 5, "2026-01-02T00:00:00Z")]) {
      await kv.set(KV.observations(SESSION), r.id, r);
    }
    const set = kv.set;
    kv.set = async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (scope === KV.observations(SESSION)) throw new Error("database or disk is full");
      return set(scope, key, data);
    };
    registerObserveFunction(sdk as never, kv as never, undefined, 2);

    await expect(
      sdk.trigger({
        function_id: "mem::observe",
        payload: {
          sessionId: SESSION,
          hookType: "post_tool_use",
          timestamp: "2026-05-01T00:00:00Z",
          data: { tool_name: "Read", tool_input: { file_path: "new.ts" } },
        },
      }),
    ).rejects.toThrow("database or disk is full");
    expect((await kv.list<{ id: string }>(KV.observations(SESSION))).map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("stores the Observation and counts it when eviction fails", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    await kv.set(KV.observations(SESSION), "a", stored("a", 2, "2026-01-01T00:00:00Z"));
    await kv.set(KV.sessions, SESSION, {
      id: SESSION,
      project: "p",
      cwd: "/p",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 1,
    });
    const list = kv.list;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.observations(SESSION)) throw new Error("boom");
      return list<T>(scope);
    };
    registerObserveFunction(sdk as never, kv as never, undefined, 1);

    const result = (await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        sessionId: SESSION,
        hookType: "post_tool_use",
        timestamp: "2026-05-01T00:00:00Z",
        data: { tool_name: "Read", tool_input: { file_path: "new.ts" } },
      },
    })) as { observationId?: string };

    expect(result.observationId).toBeTruthy();
    expect(await kv.get(KV.sessions, SESSION)).toMatchObject({ observationCount: 2 });
  });

  it("counts a row as evicted when releasing its image fails", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    await kv.set(KV.observations(SESSION), "a", {
      ...stored("a", 2, "2026-01-01T00:00:00Z"),
      imageData: "/nonexistent/a.png",
    });
    await kv.set(KV.sessions, SESSION, {
      id: SESSION,
      project: "p",
      cwd: "/p",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 1,
    });
    const del = kv.delete;
    kv.delete = async (scope: string, key: string) => {
      if (scope.startsWith("mem:image")) throw new Error("database or disk is full");
      return del(scope, key);
    };
    registerObserveFunction(sdk as never, kv as never, undefined, 1);

    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        sessionId: SESSION,
        hookType: "post_tool_use",
        timestamp: "2026-05-01T00:00:00Z",
        data: { tool_name: "Read", tool_input: { file_path: "new.ts" } },
      },
    });

    expect(await kv.list(KV.observations(SESSION))).toHaveLength(1);
    expect(await kv.get(KV.sessions, SESSION)).toMatchObject({ observationCount: 1 });
  });

  it("evicts nothing under the cap", async () => {
    const { ids } = await setup([stored("a", 1, "2026-01-01T00:00:00Z")], 3);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("a");
  });
});
