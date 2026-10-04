import { describe, expect, it, vi } from "vitest";
import type {
  CompressedObservation,
  RawObservation,
  Session,
} from "../src/types.js";
import { registerEvictFunction } from "../src/functions/evict.js";
import { KV } from "../src/state/schema.js";
import { logger } from "../src/logger.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The recovered-session consolidation pass is gated on isConsolidationEnabled
// (keyless installs skip it); force it on so these tests exercise the pass.
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  isConsolidationEnabled: () => true,
}));

type Store = Map<string, Map<string, unknown>>;
type Handler = (payload: unknown) => unknown | Promise<unknown>;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeSession(id: string): Session {
  return {
    id,
    project: "agentmemory",
    cwd: "/repo/agentmemory",
    startedAt: daysAgo(31),
    status: "active",
    observationCount: 1,
  };
}

function makeObservation(sessionId: string): CompressedObservation {
  return {
    id: "obs_1",
    sessionId,
    timestamp: daysAgo(31),
    type: "decision",
    title: "Chose sqlite storage",
    facts: ["Use sqlite for local state"],
    narrative: "The session chose sqlite for local state.",
    concepts: ["sqlite"],
    files: ["src/state/kv.ts"],
    importance: 8,
  };
}

function makeRawObservation(sessionId: string): RawObservation {
  return {
    id: "raw_1",
    sessionId,
    timestamp: daysAgo(31),
    hookType: "post_tool_use",
    toolName: "Edit",
    raw: { file_path: "src/state/kv.ts" },
  };
}

function mockKV(store: Store, listFailures: Set<string> = new Set()) {
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
    update: async (
      scope: string,
      key: string,
      ops: Array<{ type: string; path: string; value?: unknown }>,
    ): Promise<unknown> => {
      const row = store.get(scope)?.get(key) as Record<string, unknown>;
      for (const op of ops) if (op.type === "set") row[op.path] = op.value;
      return row;
    },
    list: async <T>(scope: string): Promise<T[]> => {
      if (listFailures.has(scope)) {
        throw new Error(`list failed for ${scope}`);
      }
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const handlers = new Map<string, Handler>();
  const calls: Array<{ function_id: string; payload: unknown }> = [];
  return {
    calls,
    sdk: {
      registerFunction: (functionId: string, handler: Handler) => {
        handlers.set(functionId, handler);
      },
      trigger: async (input: { function_id: string; payload: unknown }) => {
        calls.push(input);
        const handler = handlers.get(input.function_id);
        if (!handler) throw new Error(`missing handler: ${input.function_id}`);
        return handler(input.payload);
      },
    },
  };
}

function storeForObservations(
  sessionId: string,
  observations: Array<CompressedObservation | RawObservation>,
): Store {
  const session = makeSession(sessionId);
  return new Map([
    [KV.sessions, new Map([[session.id, session]])],
    [KV.summaries, new Map()],
    [
      KV.observations(session.id),
      new Map(observations.map((observation) => [observation.id, observation])),
    ],
    [KV.config, new Map()],
    [KV.audit, new Map()],
  ]);
}

function storeForObservedSession(sessionId: string): Store {
  return storeForObservations(sessionId, [makeObservation(sessionId)]);
}

describe("mem::evict stale sessions", () => {
  it("runs session recovery before deleting a stale observed session", async () => {
    const sessionId = "ses_stale";
    const store = storeForObservedSession(sessionId);
    const kv = mockKV(store);
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::stopped", async (payload) => {
      // Recovery must say so, which suppresses the per-session fan-out
      // (evict runs a single corpus-wide pass afterwards).
      expect(payload).toEqual({ sessionId, recovery: true });
      expect(await kv.get(KV.sessions, sessionId)).toMatchObject({
        id: sessionId,
      });
      return { success: true };
    });
    sdk.registerFunction("mem::consolidate-pipeline", () => ({
      success: true,
    }));
    sdk.registerFunction("mem::auto-crystallize", () => ({ success: true }));

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(1);
    expect(await kv.get(KV.sessions, sessionId)).toBeNull();
    const audits = await kv.list<{
      details: { reason: string };
    }>(KV.audit);
    expect(audits[0].details.reason).toBe(
      "stale_session_recovered_then_evicted",
    );
    expect(calls.map((call) => call.function_id)).toContain(
      "event::session::stopped",
    );
    expect(calls.map((call) => call.function_id)).toContain(
      "mem::consolidate-pipeline",
    );
  });

  it("bounds consolidation to one pass regardless of how many stale sessions are recovered", async () => {
    // Regression (P1): before the recovery guard, N recovered
    // sessions each triggered a forced full-corpus consolidate + crystallize
    // via the session::stopped fan-out, on top of evict's final pass — an
    // N+1 amplification of an expensive LLM path. Recovery must stay O(1).
    const ids = ["ses_a", "ses_b", "ses_c"];
    const store: Store = new Map([
      [
        KV.sessions,
        new Map(ids.map((id) => [id, makeSession(id)])),
      ],
      [KV.summaries, new Map()],
      [KV.config, new Map()],
      [KV.audit, new Map()],
    ]);
    for (const id of ids) {
      store.set(
        KV.observations(id),
        new Map([["obs_1", makeObservation(id)]]),
      );
    }
    const kv = mockKV(store);
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    const stoppedPayloads: unknown[] = [];
    sdk.registerFunction("event::session::stopped", (payload) => {
      stoppedPayloads.push(payload);
      return { success: true };
    });
    sdk.registerFunction("mem::consolidate-pipeline", () => ({ success: true }));
    sdk.registerFunction("mem::auto-crystallize", () => ({ success: true }));

    await sdk.trigger({ function_id: "mem::evict", payload: {} });

    // session::stopped fires once per recovered session, each suppressing its
    // own fan-out...
    expect(stoppedPayloads).toHaveLength(3);
    for (const p of stoppedPayloads) {
      expect(p).toMatchObject({ recovery: true });
    }
    // ...and the corpus-wide consolidation + crystallization run exactly once.
    const fnIds = calls.map((c) => c.function_id);
    expect(fnIds.filter((f) => f === "mem::consolidate-pipeline")).toHaveLength(1);
    expect(fnIds.filter((f) => f === "mem::auto-crystallize")).toHaveLength(1);
  });

  it("recovers Sessions one at a time, an Abandoned one included", async () => {
    const ids = ["ses_a", "ses_b"];
    const store: Store = new Map([
      [
        KV.sessions,
        new Map(ids.map((id) => [id, { ...makeSession(id), status: "abandoned" as const }])),
      ],
      [KV.summaries, new Map()],
      [KV.config, new Map()],
      [KV.audit, new Map()],
    ]);
    for (const id of ids) {
      store.set(KV.observations(id), new Map([["obs_1", makeObservation(id)]]));
    }
    const kv = mockKV(store);
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);
    const events: string[] = [];
    sdk.registerFunction("event::session::stopped", async (payload) => {
      const { sessionId } = payload as { sessionId: string };
      events.push(`start ${sessionId}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`end ${sessionId}`);
      return { success: true };
    });
    sdk.registerFunction("mem::consolidate-pipeline", () => ({ success: true }));
    sdk.registerFunction("mem::auto-crystallize", () => ({ success: true }));

    const result = (await sdk.trigger({ function_id: "mem::evict", payload: {} })) as {
      staleSessions: number;
    };

    expect(events).toEqual(["start ses_a", "end ses_a", "start ses_b", "end ses_b"]);
    expect(result.staleSessions).toBe(2);
  });

  it("does not start a second recovery sweep while one is running", async () => {
    const sessionId = "ses_stale";
    const kv = mockKV(storeForObservedSession(sessionId));
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);
    let recoveries = 0;
    sdk.registerFunction("event::session::stopped", async () => {
      recoveries++;
      await new Promise((r) => setTimeout(r, 5));
      return { success: true };
    });
    sdk.registerFunction("mem::consolidate-pipeline", () => ({ success: true }));
    sdk.registerFunction("mem::auto-crystallize", () => ({ success: true }));

    await Promise.all([
      sdk.trigger({ function_id: "mem::evict", payload: {} }),
      sdk.trigger({ function_id: "mem::evict", payload: {} }),
    ]);

    expect(recoveries).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("recovery already running"),
      { staleSessions: 1 },
    );
  });

  it("keeps a stale observed session when recovery fails", async () => {
    const sessionId = "ses_unrecovered";
    const store = storeForObservedSession(sessionId);
    const kv = mockKV(store);
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::stopped", () => ({
      success: false,
      error: "no_provider",
    }));

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(0);
    expect(await kv.get(KV.sessions, sessionId)).toMatchObject({
      id: sessionId,
    });
    expect(calls.map((call) => call.function_id)).toContain(
      "event::session::stopped",
    );
    expect(calls.map((call) => call.function_id)).not.toContain(
      "mem::consolidate-pipeline",
    );
  });

  it("keeps a stale session when observation scanning fails", async () => {
    const sessionId = "ses_scan_failed";
    const store = storeForObservedSession(sessionId);
    const kv = mockKV(store, new Set([KV.observations(sessionId)]));
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::stopped", () => ({
      success: true,
    }));

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(0);
    expect(await kv.get(KV.sessions, sessionId)).toMatchObject({
      id: sessionId,
    });
    expect(calls.map((call) => call.function_id)).not.toContain(
      "event::session::stopped",
    );
  });

  it("keeps a stale session whose raw observations fail to compress", async () => {
    const sessionId = "ses_compress_failed";
    const store = storeForObservations(sessionId, [
      makeRawObservation(sessionId),
    ]);
    const kv = mockKV(store);
    kv.set = async () => {
      throw new Error("disk full");
    };
    const { sdk, calls } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(0);
    expect(await kv.get(KV.sessions, sessionId)).toMatchObject({
      id: sessionId,
    });
    expect(calls.map((call) => call.function_id)).not.toContain(
      "event::session::stopped",
    );
  });

  it("compresses a stale session's raw observations, then recovers and evicts it", async () => {
    const sessionId = "ses_raw_only";
    const store = storeForObservations(sessionId, [
      makeRawObservation(sessionId),
    ]);
    const kv = mockKV(store);
    const { sdk } = mockSdk();

    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::stopped", async () => {
      const [obs] = await kv.list<CompressedObservation>(KV.observations(sessionId));
      expect(obs).toMatchObject({ id: "raw_1", title: "Edit" });
      return { success: true };
    });
    sdk.registerFunction("mem::consolidate-pipeline", () => ({ success: true }));
    sdk.registerFunction("mem::auto-crystallize", () => ({ success: true }));

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(1);
    expect(await kv.get(KV.sessions, sessionId)).toBeNull();
  });
});

describe("mem::evict session observation counts", () => {
  function observation(
    sessionId: string,
    id: string,
    { ageDays, importance }: { ageDays: number; importance: number },
  ): CompressedObservation {
    return {
      ...makeObservation(sessionId),
      id,
      timestamp: daysAgo(ageDays),
      importance,
    };
  }

  const lowValue = { ageDays: 100, importance: 1 };

  function liveSession(id: string, observationCount: number): Session {
    return { ...makeSession(id), startedAt: daysAgo(1), observationCount };
  }

  function storeForSessions(
    sessions: Array<{ session: Session; observations: CompressedObservation[] }>,
  ): Store {
    const store: Store = new Map([
      [KV.sessions, new Map(sessions.map(({ session }) => [session.id, session]))],
      [KV.summaries, new Map()],
      [KV.config, new Map()],
      [KV.audit, new Map()],
    ]);
    for (const { session, observations } of sessions) {
      store.set(
        KV.observations(session.id),
        new Map(observations.map((o) => [o.id, o])),
      );
    }
    return store;
  }

  async function evict(store: Store): Promise<ReturnType<typeof mockKV>> {
    const kv = mockKV(store);
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);
    await sdk.trigger({ function_id: "mem::evict", payload: {} });
    return kv;
  }

  it("lowers a Session's count by the number of Observations evicted from it", async () => {
    const sessionId = "ses_live";
    const kv = await evict(
      storeForSessions([
        {
          session: liveSession(sessionId, 5),
          observations: [
            observation(sessionId, "obs_a", lowValue),
            observation(sessionId, "obs_b", lowValue),
            makeObservation(sessionId),
          ],
        },
      ]),
    );

    expect(await kv.list(KV.observations(sessionId))).toHaveLength(1);
    expect(await kv.get<Session>(KV.sessions, sessionId)).toMatchObject({
      observationCount: 3,
    });
  });

  it("floors a count already below the number evicted at zero", async () => {
    const sessionId = "ses_undercounted";
    const kv = await evict(
      storeForSessions([
        {
          session: liveSession(sessionId, 1),
          observations: [
            observation(sessionId, "obs_a", lowValue),
            observation(sessionId, "obs_b", lowValue),
            observation(sessionId, "obs_c", lowValue),
          ],
        },
      ]),
    );

    expect(await kv.get<Session>(KV.sessions, sessionId)).toMatchObject({
      observationCount: 0,
    });
  });

  it("lowers each Session by its own share of a project cap eviction", async () => {
    const store = storeForSessions([
      {
        session: liveSession("ses_a", 2),
        observations: [
          observation("ses_a", "a1", { ageDays: 1, importance: 1 }),
          observation("ses_a", "a2", { ageDays: 1, importance: 2 }),
        ],
      },
      {
        session: liveSession("ses_b", 2),
        observations: [
          observation("ses_b", "b1", { ageDays: 1, importance: 3 }),
          observation("ses_b", "b2", { ageDays: 1, importance: 9 }),
        ],
      },
    ]);
    store.get(KV.config)!.set("eviction", { maxObservationsPerProject: 1 });

    const kv = await evict(store);

    expect(await kv.get<Session>(KV.sessions, "ses_a")).toMatchObject({
      observationCount: 0,
    });
    expect(await kv.get<Session>(KV.sessions, "ses_b")).toMatchObject({
      observationCount: 1,
    });
  });

  it("counts an Observation removed by the low-importance pass only once when the cap also bites", async () => {
    const sessionId = "ses_both";
    const store = storeForSessions([
      {
        session: liveSession(sessionId, 5),
        observations: [
          observation(sessionId, "old_a", lowValue),
          observation(sessionId, "old_b", lowValue),
          observation(sessionId, "new_a", { ageDays: 1, importance: 4 }),
          observation(sessionId, "new_b", { ageDays: 1, importance: 5 }),
          observation(sessionId, "new_c", { ageDays: 1, importance: 6 }),
        ],
      },
    ]);
    store.get(KV.config)!.set("eviction", { maxObservationsPerProject: 1 });
    const kv = mockKV(store);
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);

    const stats = await sdk.trigger({ function_id: "mem::evict", payload: {} });

    expect(stats).toMatchObject({ lowImportanceObs: 2, capEvictions: 2 });
    expect(await kv.list(KV.observations(sessionId))).toHaveLength(1);
    expect(await kv.get<Session>(KV.sessions, sessionId)).toMatchObject({
      observationCount: 1,
    });
  });
});
