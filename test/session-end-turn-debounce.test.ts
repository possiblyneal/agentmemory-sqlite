import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

import { registerApiTriggers, SESSION_IDLE_END_MS as IDLE_MS } from "../src/triggers/api.js";
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

beforeEach(async () => {
  vi.useFakeTimers();
  kv = mockKV();
  sdk = mockSdk();
  stopped = [];
  registerApiTriggers(sdk as never, kv as never, SECRET);
  sdk.registerFunction("event::session::stopped", async (data: { sessionId: string }) => {
    stopped.push(data.sessionId);
  });
  await kv.set(KV.sessions, "ses_1", {
    id: "ses_1",
    project: "proj",
    cwd: "/proj",
    startedAt: "2026-09-01T00:00:00.000Z",
    status: "active",
    observationCount: 2,
  } satisfies Session);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /agentmemory/session/end with turnEnd (#1131)", () => {
  it("defers the end of the Session until it has been idle", async () => {
    const res = await endSession({ sessionId: "ses_1", turnEnd: true });

    expect(res.status_code).toBe(200);
    expect((await kv.get<Session>(KV.sessions, "ses_1"))?.status).toBe("active");
    expect(stopped).toEqual([]);

    await vi.advanceTimersByTimeAsync(IDLE_MS);

    const session = await kv.get<Session>(KV.sessions, "ses_1");
    expect(session?.status).toBe("completed");
    expect(typeof session?.endedAt).toBe("string");
    expect(stopped).toEqual(["ses_1"]);
  });

  it("restarts the idle wait on every turn, so a busy Session ends once", async () => {
    for (let turn = 0; turn < 4; turn++) {
      await endSession({ sessionId: "ses_1", turnEnd: true });
      await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000);
    }
    expect(stopped).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toEqual(["ses_1"]);
  });

  it("waits again while Observations keep arriving, so a long turn is not ended midway", async () => {
    await endSession({ sessionId: "ses_1", turnEnd: true });
    await kv.update(KV.sessions, "ses_1", [
      { type: "set", path: "observationCount", value: 9 },
    ]);

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect((await kv.get<Session>(KV.sessions, "ses_1"))?.status).toBe("active");
    expect(stopped).toEqual([]);

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(stopped).toEqual(["ses_1"]);
  });

  it("ends at once on a real session end and drops the pending turn end", async () => {
    await endSession({ sessionId: "ses_1", turnEnd: true });
    await endSession({ sessionId: "ses_1" });
    expect(stopped).toEqual(["ses_1"]);

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(stopped).toEqual(["ses_1"]);
  });

  it("still answers 404 for a Session that never started", async () => {
    const res = await endSession({ sessionId: "ses_never", turnEnd: true });
    expect(res.status_code).toBe(404);

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(stopped).toEqual([]);
  });
});
