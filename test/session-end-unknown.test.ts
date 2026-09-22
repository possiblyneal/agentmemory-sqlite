import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

const SECRET = "session-end-test-secret";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const scope = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  return {
    get: async <T>(s: string, key: string): Promise<T | null> =>
      (store.get(s)?.get(key) as T) ?? null,
    set: async <T>(s: string, key: string, data: T): Promise<T> => {
      scope(s).set(key, data);
      return data;
    },
    delete: async (s: string, key: string): Promise<void> => {
      store.get(s)?.delete(key);
    },
    update: async (
      s: string,
      key: string,
      ops: Array<{ type: string; path: string; value: unknown }>,
    ) => {
      const base = { ...((store.get(s)?.get(key) as object) ?? {}) } as Record<string, unknown>;
      for (const op of ops) base[op.path] = op.value;
      scope(s).set(key, base);
    },
    list: async <T>(s: string): Promise<T[]> =>
      Array.from(store.get(s)?.values() ?? []) as T[],
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

let kv: ReturnType<typeof mockKV>;
let sdk: ReturnType<typeof mockSdk>;
let stopped: string[];

function endSession(body: Record<string, unknown>) {
  return sdk._fns.get("api::session::end")!({
    headers: { authorization: `Bearer ${SECRET}` },
    body,
  }) as Promise<{ status_code: number; body: Record<string, unknown> }>;
}

beforeEach(() => {
  kv = mockKV();
  sdk = mockSdk();
  stopped = [];
  registerApiTriggers(sdk as never, kv as never, SECRET);
  sdk.registerFunction("event::session::stopped", async (data: { sessionId: string }) => {
    stopped.push(data.sessionId);
  });
});

describe("POST /agentmemory/session/end", () => {
  it("answers 404 session_not_found for a Session that never started and writes nothing", async () => {
    const res = await endSession({ sessionId: "ses_never" });

    expect(res.status_code).toBe(404);
    expect(res.body).toEqual({ error: "session_not_found" });
    expect(await kv.list(KV.sessions)).toEqual([]);
    expect(stopped).toEqual([]);
  });

  it("ends a known Session as before", async () => {
    await kv.set(KV.sessions, "ses_1", {
      id: "ses_1",
      project: "proj",
      cwd: "/proj",
      startedAt: "2026-09-01T00:00:00.000Z",
      status: "active",
      observationCount: 2,
    } satisfies Session);

    const res = await endSession({ sessionId: "ses_1" });

    expect(res.status_code).toBe(200);
    expect(res.body).toEqual({ success: true });
    const session = await kv.get<Session>(KV.sessions, "ses_1");
    expect(session?.status).toBe("completed");
    expect(typeof session?.endedAt).toBe("string");
    expect(stopped).toEqual(["ses_1"]);
  });

  it("still rejects a missing sessionId with 400", async () => {
    const res = await endSession({});
    expect(res.status_code).toBe(400);
  });
});
