import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

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
    update: async (scope: string, key: string, ops: Array<{ type: string; path: string; value?: unknown }>) => {
      const old_value = store.get(scope)?.get(key);
      const value = structuredClone((old_value ?? {}) as Record<string, unknown>);
      for (const op of ops) {
        if (op.type === "set") value[op.path] = op.value;
        if (op.type === "remove") delete value[op.path];
      }
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return { old_value, new_value: value };
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
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

describe("POST /agentmemory/session/start title (#276)", () => {
  it("records the title as firstPrompt and leaves summary to the summarizer", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never, undefined);
    sdk._fns.set("mem::context", () => ({ context: "" }));

    await sdk._fns.get("api::session::start")!({
      headers: {},
      body: { sessionId: "ses_1", project: "/p", cwd: "/p", title: "fix the flaky test" },
    });

    const session = await kv.get<Session>(KV.sessions, "ses_1");
    expect(session?.firstPrompt).toBe("fix the flaky test");
    expect(session).not.toHaveProperty("summary");
  });

  it("reopens an existing Session without resetting what it accumulated", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never, undefined);
    sdk._fns.set("mem::context", () => ({ context: "" }));
    const original: Session = {
      id: "ses_1",
      project: "/p",
      cwd: "/p",
      startedAt: "2026-10-01T00:00:00.000Z",
      endedAt: "2026-10-01T02:00:00.000Z",
      status: "completed",
      observationCount: 42,
      firstPrompt: "fix the flaky test",
      commitShas: ["abc123"],
    };
    await kv.set(KV.sessions, original.id, original);

    await sdk._fns.get("api::session::start")!({
      headers: {},
      body: { sessionId: "ses_1", project: "/p", cwd: "/p/sub", title: "a later prompt" },
    });

    const session = await kv.get<Session>(KV.sessions, "ses_1");
    expect(session).toEqual({
      ...original,
      cwd: "/p/sub",
      status: "active",
      endedAt: undefined,
    });
    expect(session).not.toHaveProperty("endedAt");
  });
});
