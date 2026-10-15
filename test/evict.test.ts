import { describe, expect, it, vi } from "vitest";
import type {
  CompressedObservation,
  Memory,
  RawObservation,
  Session,
  SessionSummary,
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

function summaryFor(sessionId: string): SessionSummary {
  return {
    sessionId,
    project: "agentmemory",
    createdAt: new Date().toISOString(),
    title: "Summary",
    narrative: "",
    keyDecisions: [],
    filesModified: [],
    concepts: [],
    observationCount: 0,
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

  it("runs at most one recovery at a time when two sweeps overlap", async () => {
    const sessionId = "ses_stale";
    const kv = mockKV(storeForObservedSession(sessionId));
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);
    let running = 0;
    let peak = 0;
    let recoveries = 0;
    sdk.registerFunction("event::session::stopped", async () => {
      recoveries++;
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { success: true };
    });
    sdk.registerFunction("mem::consolidate-pipeline", () => ({ success: true }));
    sdk.registerFunction("mem::auto-crystallize", () => ({ success: true }));

    await Promise.all([
      sdk.trigger({ function_id: "mem::evict", payload: {} }),
      sdk.trigger({ function_id: "mem::evict", payload: {} }),
    ]);

    expect(recoveries).toBe(1);
    expect(peak).toBe(1);
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

// The floor before #225, so the cap cases evict only what the cap selects.
const PRE_225_FLOOR = { lowImportanceThreshold: 3, lowImportanceMaxDays: 90 };

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
      [KV.summaries, new Map(sessions.map(({ session }) => [session.id, summaryFor(session.id)]))],
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

  it("deletes each Observation once when two sweeps overlap", async () => {
    const sessionId = "ses_overlap";
    const store = storeForSessions([
      {
        session: liveSession(sessionId, 5),
        observations: [
          observation(sessionId, "obs_a", lowValue),
          observation(sessionId, "obs_b", lowValue),
          { ...makeObservation(sessionId), id: "obs_keep" },
        ],
      },
    ]);
    const kv = mockKV(store);
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);

    const [first, second] = (await Promise.all([
      sdk.trigger({ function_id: "mem::evict", payload: {} }),
      sdk.trigger({ function_id: "mem::evict", payload: {} }),
    ])) as Array<{ lowImportanceObs: number }>;

    expect(await kv.list(KV.observations(sessionId))).toHaveLength(1);
    expect(await kv.get<Session>(KV.sessions, sessionId)).toMatchObject({
      observationCount: 3,
    });
    expect(first.lowImportanceObs).toBe(2);
    expect(second.lowImportanceObs).toBe(0);
  });

  it("keeps a shared image referenced when two sweeps overlap", async () => {
    const sessionId = "ses_images";
    const image = "images/shared.png";
    const store = storeForSessions([
      {
        session: liveSession(sessionId, 2),
        observations: [
          { ...observation(sessionId, "obs_old", lowValue), imageRef: image },
          { ...makeObservation(sessionId), id: "obs_keep", imageRef: image },
        ],
      },
    ]);
    store.set(KV.imageRefs, new Map([[image, 2]]));
    const kv = mockKV(store);
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);

    await Promise.all([
      sdk.trigger({ function_id: "mem::evict", payload: {} }),
      sdk.trigger({ function_id: "mem::evict", payload: {} }),
    ]);

    expect(await kv.get<number>(KV.imageRefs, image)).toBe(1);
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
    store.get(KV.config)!.set("eviction", {
      ...PRE_225_FLOOR,
      maxObservationsPerProject: 1,
    });

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
    store.get(KV.config)!.set("eviction", {
      ...PRE_225_FLOOR,
      maxObservationsPerProject: 1,
    });
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

  it("deletes the obs-nodes row of every Observation it evicts and keeps the rest", async () => {
    const sessionId = "ses_graph";
    const store = storeForSessions([
      {
        session: liveSession(sessionId, 3),
        observations: [
          observation(sessionId, "old_a", lowValue),
          observation(sessionId, "new_a", { ageDays: 1, importance: 4 }),
          observation(sessionId, "new_b", { ageDays: 1, importance: 9 }),
        ],
      },
    ]);
    store.get(KV.config)!.set("eviction", {
      ...PRE_225_FLOOR,
      maxObservationsPerProject: 1,
    });
    store.set(
      KV.graphObsNodes,
      new Map([
        ["old_a", ["n1"]],
        ["new_a", ["n2"]],
        ["new_b", ["n3"]],
      ]),
    );
    const kv = mockKV(store);
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);

    await sdk.trigger({ function_id: "mem::evict", payload: {} });

    expect(await kv.get(KV.graphObsNodes, "old_a")).toBeNull();
    expect(await kv.get(KV.graphObsNodes, "new_a")).toBeNull();
    expect(await kv.get(KV.graphObsNodes, "new_b")).toEqual(["n3"]);
  });
});

describe("mem::evict default importance floor", () => {
  function obs(
    sessionId: string,
    id: string,
    ageDays: number,
    importance: number,
  ): CompressedObservation {
    return {
      ...makeObservation(sessionId),
      id,
      timestamp: daysAgo(ageDays),
      importance,
    };
  }

  function memory(id: string, ageDays: number, isLatest: boolean): Memory {
    return {
      id,
      createdAt: daysAgo(ageDays),
      updatedAt: daysAgo(ageDays),
      type: "fact",
      title: id,
      content: id,
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest,
    };
  }

  function setup(
    observations: CompressedObservation[],
    memories: Memory[] = [],
    config?: Record<string, unknown>,
  ) {
    const session: Session = { ...makeSession("ses_d"), startedAt: daysAgo(1) };
    const store: Store = new Map([
      [KV.sessions, new Map([[session.id, session]])],
      [KV.summaries, new Map([[session.id, summaryFor(session.id)]])],
      [KV.observations(session.id), new Map(observations.map((o) => [o.id, o]))],
      [KV.memories, new Map(memories.map((m) => [m.id, m]))],
      [KV.config, new Map()],
      [KV.audit, new Map()],
    ]);
    if (config) store.get(KV.config)!.set("eviction", config);
    const kv = mockKV(store);
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);
    const run = (dryRun = false) =>
      sdk.trigger({ function_id: "mem::evict", payload: { dryRun } }) as Promise<
        Record<string, unknown>
      >;
    const keptObs = async () =>
      (await kv.list<CompressedObservation>(KV.observations(session.id)))
        .map((o) => o.id)
        .sort();
    const keptMem = async () =>
      (await kv.list<Memory>(KV.memories)).map((m) => m.id).sort();
    return { run, keptObs, keptMem };
  }

  it("removes a one-day-old Observation of importance 4 and keeps importance 5 and a fresh one", async () => {
    const t = setup([
      obs("ses_d", "low", 1, 4),
      obs("ses_d", "ok", 1, 5),
      obs("ses_d", "fresh", 0, 4),
    ]);

    const stats = await t.run();

    expect(stats).toMatchObject({ lowImportanceObs: 1 });
    expect(await t.keptObs()).toEqual(["fresh", "ok"]);
  });

  it("keeps a superseded Memory under 90 days old and evicts one over 90", async () => {
    const t = setup([], [
      memory("young", 30, false),
      memory("old", 100, false),
      memory("latest", 100, true),
    ]);

    const stats = await t.run();

    expect(stats).toMatchObject({ nonLatestMemories: 1 });
    expect(await t.keptMem()).toEqual(["latest", "young"]);
  });

  it("reports the default removals on a dry run without deleting", async () => {
    const t = setup(
      [obs("ses_d", "low", 1, 4), obs("ses_d", "ok", 1, 5)],
      [memory("old", 100, false)],
    );

    const stats = await t.run(true);

    expect(stats).toMatchObject({
      dryRun: true,
      lowImportanceObs: 1,
      nonLatestMemories: 1,
    });
    expect(await t.keptObs()).toEqual(["low", "ok"]);
    expect(await t.keptMem()).toEqual(["old"]);
  });

  it("honours a lowImportanceThreshold override", async () => {
    const t = setup(
      [obs("ses_d", "four", 1, 4), obs("ses_d", "two", 1, 2)],
      [],
      { lowImportanceThreshold: 3 },
    );

    await t.run();

    expect(await t.keptObs()).toEqual(["four"]);
  });

  it("honours a lowImportanceMaxDays override", async () => {
    const t = setup(
      [obs("ses_d", "new", 1, 1), obs("ses_d", "old", 100, 1)],
      [],
      { lowImportanceMaxDays: 90 },
    );

    await t.run();

    expect(await t.keptObs()).toEqual(["new"]);
  });

  it("honours a nonLatestMemoryMaxDays override", async () => {
    const t = setup([], [memory("m", 10, false)], { nonLatestMemoryMaxDays: 5 });

    await t.run();

    expect(await t.keptMem()).toEqual([]);
  });

  it("does not let lowImportanceMaxDays gate superseded Memories", async () => {
    const t = setup([], [memory("m", 30, false)], { lowImportanceMaxDays: 0 });

    await t.run();

    expect(await t.keptMem()).toEqual(["m"]);
  });
});

describe("mem::evict spares Observations their Session's stop has not finished with", () => {
  const sessionId = "ses_gate";

  function obs(id: string, timestamp: string, importance = 1): CompressedObservation {
    return { ...makeObservation(sessionId), id, timestamp, importance };
  }

  function setup(opts: {
    observations: CompressedObservation[];
    summaryAt?: string;
    extractedThrough?: string;
    config?: Record<string, unknown>;
  }) {
    const session: Session = {
      ...makeSession(sessionId),
      startedAt: daysAgo(1),
      ...(opts.extractedThrough
        ? { graphExtractedThrough: opts.extractedThrough }
        : {}),
    };
    const store: Store = new Map([
      [KV.sessions, new Map([[session.id, session]])],
      [
        KV.summaries,
        new Map(
          opts.summaryAt
            ? [[sessionId, { sessionId, createdAt: opts.summaryAt }]]
            : [],
        ),
      ],
      [KV.observations(sessionId), new Map(opts.observations.map((o) => [o.id, o]))],
      [KV.config, new Map(opts.config ? [["eviction", opts.config]] : [])],
      [KV.audit, new Map()],
    ]);
    const kv = mockKV(store);
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, kv as never);
    const run = (dryRun = false) =>
      sdk.trigger({ function_id: "mem::evict", payload: { dryRun } }) as Promise<
        Record<string, number>
      >;
    const kept = async () =>
      (await kv.list<CompressedObservation>(KV.observations(sessionId)))
        .map((o) => o.id)
        .sort();
    return { run, kept };
  }

  async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
    const saved = Object.fromEntries(
      Object.keys(vars).map((k) => [k, process.env[k]]),
    );
    Object.assign(process.env, vars);
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("keeps an old low-importance Observation whose Session has no Summary", async () => {
    const t = setup({ observations: [obs("a", daysAgo(5))] });

    expect(await t.run()).toMatchObject({ lowImportanceObs: 0 });
    expect(await t.kept()).toEqual(["a"]);
  });

  it("keeps one written after its Session's Summary and evicts one written before it", async () => {
    const t = setup({
      observations: [obs("before", daysAgo(5)), obs("after", daysAgo(3))],
      summaryAt: daysAgo(4),
    });

    expect(await t.run()).toMatchObject({ lowImportanceObs: 1 });
    expect(await t.kept()).toEqual(["after"]);
  });

  it("reports the same count on a dry run without deleting", async () => {
    const t = setup({
      observations: [obs("before", daysAgo(5)), obs("after", daysAgo(3))],
      summaryAt: daysAgo(4),
    });

    expect(await t.run(true)).toMatchObject({ lowImportanceObs: 1, dryRun: true });
    expect(await t.kept()).toEqual(["after", "before"]);
  });

  it("with graph extraction enabled keeps one past the watermark and evicts one behind it", async () => {
    await withEnv({ GRAPH_EXTRACTION_ENABLED: "true" }, async () => {
      const t = setup({
        observations: [obs("behind", daysAgo(5)), obs("past", daysAgo(3))],
        summaryAt: daysAgo(1),
        extractedThrough: daysAgo(4),
      });

      expect(await t.run()).toMatchObject({ lowImportanceObs: 1 });
      expect(await t.kept()).toEqual(["past"]);
    });
  });

  it("with graph extraction enabled keeps everything when the Session has no watermark", async () => {
    await withEnv({ GRAPH_EXTRACTION_ENABLED: "true" }, async () => {
      const t = setup({
        observations: [obs("a", daysAgo(5))],
        summaryAt: daysAgo(1),
      });

      expect(await t.run()).toMatchObject({ lowImportanceObs: 0 });
      expect(await t.kept()).toEqual(["a"]);
    });
  });

  it("ignores the watermark with graph extraction disabled", async () => {
    await withEnv({ GRAPH_EXTRACTION_ENABLED: "false" }, async () => {
      const t = setup({
        observations: [obs("past", daysAgo(3))],
        summaryAt: daysAgo(1),
        extractedThrough: daysAgo(4),
      });

      expect(await t.run()).toMatchObject({ lowImportanceObs: 1 });
    });
  });

  it("ignores the watermark when the graph leg is off", async () => {
    await withEnv(
      { GRAPH_EXTRACTION_ENABLED: "true", AGENTMEMORY_GRAPH_LEG: "off" },
      async () => {
        const t = setup({
          observations: [obs("past", daysAgo(3))],
          summaryAt: daysAgo(1),
          extractedThrough: daysAgo(4),
        });

        expect(await t.run()).toMatchObject({ lowImportanceObs: 1 });
      },
    );
  });

  it("makes the per-project cap skip Observations that fail the rule", async () => {
    const t = setup({
      observations: [
        obs("a", daysAgo(0.5), 1),
        obs("b", daysAgo(0.4), 2),
        obs("c", daysAgo(0.3), 3),
      ],
      summaryAt: daysAgo(0.45),
      config: { maxObservationsPerProject: 1 },
    });

    expect(await t.run()).toMatchObject({ capEvictions: 1 });
    expect(await t.kept()).toEqual(["b", "c"]);
  });
});
