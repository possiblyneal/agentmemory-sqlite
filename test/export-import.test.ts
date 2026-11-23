import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerSnapshotFunction } from "../src/functions/snapshot.js";
import { registerEvictFunction } from "../src/functions/evict.js";
import { pagedReads } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerExportImportFunction } from "../src/functions/export-import.js";
import { registerRelationsFunction } from "../src/functions/relations.js";
import { registerMeshFunction } from "../src/functions/mesh.js";
import { SqliteState, stateFunctions } from "../src/engine/inproc/state.js";
import { StateKV } from "../src/state/kv.js";
import { VERSION } from "../src/version.js";
import { getSearchIndex, rebuildIndex, registerSearchFunction } from "../src/functions/search.js";
import { registerEventTriggers } from "../src/triggers/events.js";
import type {
  Session,
  CompressedObservation,
  Memory,
  SessionSummary,
  ExportData,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
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
    ...pagedReads(store),
    bytes: async (scope: string): Promise<number> => {
      const entries = store.get(scope);
      return entries ? JSON.stringify(Array.from(entries.values())).length : 0;
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const testSession: Session = {
  id: "ses_1",
  project: "my-project",
  cwd: "/tmp",
  startedAt: "2026-02-01T00:00:00Z",
  status: "completed",
  observationCount: 1,
};

const testObs: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  type: "file_edit",
  title: "Edit auth",
  facts: ["Added check"],
  narrative: "Auth changes",
  concepts: ["auth"],
  files: ["src/auth.ts"],
  importance: 7,
};

const testMemory: Memory = {
  id: "mem_1",
  createdAt: "2026-02-01T00:00:00Z",
  updatedAt: "2026-02-01T00:00:00Z",
  type: "pattern",
  title: "Auth pattern",
  content: "Always validate tokens",
  concepts: ["auth"],
  files: [],
  sessionIds: ["ses_1"],
  strength: 5,
  version: 1,
  isLatest: true,
};

const testSummary: SessionSummary = {
  sessionId: "ses_1",
  project: "my-project",
  createdAt: "2026-02-01T00:00:00Z",
  title: "Auth work",
  narrative: "Worked on auth",
  keyDecisions: ["Use JWT"],
  filesModified: ["src/auth.ts"],
  concepts: ["auth"],
  observationCount: 1,
};

describe("Export/Import Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    // getSearchIndex() returns a module-level singleton shared across
    // tests. Clear it so index assertions here don't see rows added by
    // a prior test's import.
    getSearchIndex().clear();
    registerExportImportFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_1", testSession);
    await kv.set("mem:obs:ses_1", "obs_1", testObs);
    await kv.set("mem:memories", "mem_1", testMemory);
    await kv.set("mem:summaries", "ses_1", testSummary);
  });

  it("preserves execution attribution through export and replace import", async () => {
    await kv.set("mem:obs:ses_1", "obs_1", { ...testObs, executionAgentId: "worker-1", executionAgentType: "Explore" });
    const exportData = await sdk.trigger("mem::export", {}) as ExportData;
    await sdk.trigger("mem::import", { exportData, strategy: "replace" });
    const restored = await sdk.trigger("mem::export", {}) as ExportData;
    expect(restored.observations["ses_1"][0]).toMatchObject({ executionAgentId: "worker-1", executionAgentType: "Explore" });
  });

  it("export produces valid ExportData structure", async () => {
    const result = (await sdk.trigger("mem::export", {})) as ExportData;

    expect(result.version).toBe(VERSION);
    expect(result.exportedAt).toBeDefined();
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].id).toBe("ses_1");
    expect(result.observations["ses_1"].length).toBe(1);
    expect(result.memories.length).toBe(1);
    expect(result.summaries.length).toBe(1);
  });

  it("refuses an oversized export from row sizes without reading the stores", async () => {
    const bytesOf = kv.bytes;
    kv.bytes = async (scope: string) =>
      scope === "mem:memories" ? 300 * 1024 * 1024 : bytesOf(scope);
    const listed: string[] = [];
    const listOf = kv.list;
    kv.list = (async (scope: string) => {
      listed.push(scope);
      return listOf(scope);
    }) as typeof kv.list;

    const result = await sdk.trigger("mem::export", {});

    expect(result).toMatchObject({ success: false, oversized: true });
    expect(listed).toEqual(["mem:sessions"]);
  });

  it("import with merge strategy adds data", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: "ses_2", observationCount: 0 }],
      observations: {},
      memories: [{ ...testMemory, id: "mem_2", title: "New pattern" }],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; sessions: number; memories: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);
    expect(result.memories).toBe(1);

    const allSessions = await kv.list("mem:sessions");
    expect(allSessions.length).toBe(2);
  });

  it("import adds imported records to the search index", async () => {
    // Regression: mem::import wrote rows to KV but never indexed them.
    // On an existing install the boot rebuild gate (bm25.size === 0) is
    // false, so imported data stayed invisible to mem::search forever.
    const importedObs: CompressedObservation = {
      id: "obs_imported",
      sessionId: "ses_imported",
      timestamp: "2026-03-01T10:00:00Z",
      type: "file_edit",
      title: "Kubernetes deployment rollout",
      facts: ["Scaled replicas"],
      narrative: "Adjusted the kubernetes deployment rollout strategy",
      concepts: ["k8s"],
      files: ["deploy.yaml"],
      importance: 6,
    };
    const importedMem: Memory = {
      ...testMemory,
      id: "mem_imported",
      title: "Postgres connection pooling",
      content: "Use pgbouncer for postgres connection pooling",
    };
    const exportData: ExportData = {
      version: "0.9.28",
      exportedAt: new Date().toISOString(),
      sessions: [
        { ...testSession, id: "ses_imported", observationCount: 1 },
      ],
      observations: { ses_imported: [importedObs] },
      memories: [importedMem],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; observations: number; memories: number };

    expect(result.success).toBe(true);
    expect(result.observations).toBe(1);
    expect(result.memories).toBe(1);

    const idx = getSearchIndex();
    expect(idx.has("obs_imported")).toBe(true);
    expect(idx.has("mem_imported")).toBe(true);

    const obsHit = idx.search("kubernetes rollout");
    expect(obsHit.some((r) => r.obsId === "obs_imported")).toBe(true);

    const memHit = idx.search("postgres pooling");
    expect(memHit.some((r) => r.obsId === "mem_imported")).toBe(true);
  });

  it("import drops a Lesson row marked deleted by an old export", async () => {
    const base = {
      content: "x", context: "", confidence: 0.5, reinforcements: 0, source: "manual" as const,
      sourceIds: [], tags: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      decayRate: 0.05,
    };
    const exportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [], observations: {}, memories: [], summaries: [],
      lessons: [
        { ...base, id: "lsn_live" },
        { ...base, id: "lsn_dead", deleted: true },
      ],
    } as ExportData;

    await sdk.trigger("mem::import", { exportData, strategy: "merge" });

    expect((await kv.list<{ id: string }>("mem:lessons")).map((l) => l.id)).toEqual(["lsn_live"]);
  });

  it("imports an old export carrying Action and Crystal sections, ignoring them", async () => {
    const exportData = {
      version: "0.9.29",
      exportedAt: new Date().toISOString(),
      sessions: [], observations: {}, summaries: [],
      memories: [{ ...testMemory, id: "mem_old_export" }],
      actions: [{ id: "act_1", title: "placeholder", status: "cancelled" }],
      actionEdges: [{ id: "edge_1" }],
      routines: [{ id: "rtn_1" }],
      checkpoints: [{ id: "ckpt_1" }],
      sentinels: [{ id: "snt_1" }],
      sketches: [{ id: "skt_1" }],
      crystals: [{ id: "crys_1", narrative: "done" }],
    } as unknown as ExportData;

    const result = (await sdk.trigger("mem::import", { exportData, strategy: "merge" })) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(await kv.get("mem:memories", "mem_old_export")).not.toBeNull();
    for (const scope of ["mem:actions", "mem:crystals", "mem:routines", "mem:sketches"]) {
      expect(await kv.list(scope)).toEqual([]);
    }
  });

  it("import with skip strategy does not overwrite existing", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [testSession],
      observations: { ses_1: [testObs] },
      memories: [testMemory],
      summaries: [testSummary],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "skip",
    })) as { success: boolean; skipped: number; sessions: number };

    expect(result.success).toBe(true);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.sessions).toBe(0);
  });

  it("import with replace strategy clears existing data first", async () => {
    const newSession: Session = {
      id: "ses_new",
      project: "new-project",
      cwd: "/tmp/new",
      startedAt: "2026-03-01T00:00:00Z",
      status: "active",
      observationCount: 0,
    };
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [newSession],
      observations: {},
      memories: [],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; sessions: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);

    const oldSession = await kv.get("mem:sessions", "ses_1");
    expect(oldSession).toBeNull();
  });

  it("round-trips legacy-keyed relations through replace without retaining destination relations", async () => {
    const relation = { sourceId: "mem_1", targetId: "mem_2", type: "related", createdAt: "2026-01-01" };
    await kv.set("mem:relations", "rel_legacy", relation);
    const exported = await sdk.trigger("mem::export", {});
    const destination = mockKV();
    const target = mockSdk();
    registerExportImportFunction(target as never, destination as never);
    await destination.set("mem:relations", "rel_stale", { ...relation, targetId: "stale" });
    expect(await target.trigger("mem::import", { exportData: exported, strategy: "replace" })).toMatchObject({ success: true });
    expect(await destination.list("mem:relations")).toEqual([relation]);
    expect(await destination.get("mem:relations", "rel_legacy")).toEqual(relation);
  });

  it("round-trips relation types accepted by the writer", async () => {
    await kv.set("mem:memories", "mem_2", { ...testMemory, id: "mem_2" });
    registerRelationsFunction(sdk as never, kv as never);
    const created = await sdk.trigger("mem::relate", { sourceId: "mem_1", targetId: "mem_2", type: "custom" });
    expect(created.success).toBe(true);
    const exported = await sdk.trigger("mem::export", {});
    expect(await sdk.trigger("mem::import", { exportData: exported, strategy: "replace" })).toMatchObject({ success: true });
    expect(await kv.get("mem:relations", created.relationId)).toMatchObject({ type: "custom" });
  });

  it("round-trips a non-string type accepted by the relation writer", async () => {
    await kv.set("mem:memories", "mem_2", { ...testMemory, id: "mem_2" });
    registerRelationsFunction(sdk as never, kv as never);
    const created = await sdk.trigger("mem::relate", { sourceId: "mem_1", targetId: "mem_2", type: 42 });
    expect(created.success).toBe(true);
    const exported = await sdk.trigger("mem::export", {});
    expect(exported.relations[0].value.type).toBe("related");
    expect(await kv.get("mem:relations", created.relationId)).toMatchObject({ type: 42 });
    exported.relations[0].value.type = 42;
    expect(await sdk.trigger("mem::import", { exportData: exported, strategy: "replace" })).toMatchObject({ success: true });
    expect(await kv.get("mem:relations", created.relationId)).toMatchObject({ type: "related" });
  });

  it("round-trips opaque endpoints accepted by mesh without changing their values or key", async () => {
    registerMeshFunction(sdk as never, kv as never);
    const relation = { sourceId: 42, targetId: { id: "target" }, type: "related" };
    expect(await sdk.trigger("mem::mesh-receive", { relations: [relation] })).toMatchObject({ success: true, accepted: 1 });
    const exported = await sdk.trigger("mem::export", {});
    expect(await sdk.trigger("mem::import", { exportData: exported, strategy: "replace" })).toMatchObject({ success: true });
    expect(await kv.get("mem:relations", "42:[object Object]:related")).toEqual(relation);
  });

  it("replaces real SQLite relations using exact NUL-containing storage keys", async () => {
    const state = new SqliteState(":memory:");
    try {
      const handlers = stateFunctions(state);
      const realKV = new StateKV({ trigger: async ({ function_id, payload }: { function_id: string; payload: unknown }) => handlers[function_id](payload) } as never);
      const realSdk = mockSdk();
      registerExportImportFunction(realSdk as never, realKV);
      const relation = { sourceId: null, targetId: "b", type: "related" };
      await realKV.set("mem:relations", "rel\u0000original", relation);
      const exported = await realSdk.trigger("mem::export", {});
      expect(exported.relations[0].key).toBe("rel\u0000original");
      await realKV.set("mem:relations", "rel\u0000stale", { ...relation, targetId: "stale" });
      expect(await realSdk.trigger("mem::import", { exportData: exported, strategy: "replace" })).toMatchObject({ success: true });
      expect(await realKV.get("mem:relations", "rel\u0000original")).toEqual(relation);
      expect(await realKV.get("mem:relations", "rel\u0000stale")).toBeNull();
      expect(await realKV.list("mem:relations")).toEqual([relation]);
    } finally {
      state.close();
    }
  });

  it("preserves explicit null endpoints in persisted relations", async () => {
    const relation = { sourceId: null, targetId: "b", type: "related" };
    await kv.set("mem:relations", "rel_null", relation);
    const exported = await sdk.trigger("mem::export", {});
    expect(await sdk.trigger("mem::import", { exportData: exported, strategy: "replace" })).toMatchObject({ success: true });
    expect(await kv.get("mem:relations", "rel_null")).toEqual(relation);
  });

  it("omits invalid relation confidence in exports and imports without changing the source", async () => {
    const value = { sourceId: "a", targetId: "b", type: "custom", createdAt: "2026-01-01", confidence: "bad" };
    await kv.set("mem:relations", "rel_bad", value);
    const exported = await sdk.trigger("mem::export", {});
    expect(exported.relations[0].value).not.toHaveProperty("confidence");
    expect(await kv.get("mem:relations", "rel_bad")).toEqual(value);
    exported.relations[0].value.confidence = Infinity;
    expect(await sdk.trigger("mem::import", { exportData: exported, strategy: "replace" })).toMatchObject({ success: true });
    expect(await kv.get("mem:relations", "rel_bad")).not.toHaveProperty("confidence");
  });

  it("leaves relations untouched when replacing from an older export without them", async () => {
    const relation = { sourceId: "a", targetId: "b", type: "related", createdAt: "2026-01-01" };
    await kv.set("mem:relations", "rel_old", relation);
    const oldExport = { version: VERSION, exportedAt: "2026-01-01", sessions: [], observations: {}, memories: [], summaries: [] };
    expect(await sdk.trigger("mem::import", { exportData: oldExport, strategy: "replace" })).toMatchObject({ success: true });
    expect(await kv.get("mem:relations", "rel_old")).toEqual(relation);
  });

  it("restores captured legacy-keyed relations and removes later relations", async () => {
    mkdirSync("tmp", { recursive: true });
    const dir = mkdtempSync(join(process.cwd(), "tmp", "snapshot-relations-"));
    try {
      registerSnapshotFunction(sdk as never, kv as never, dir);
      const relation = { sourceId: "mem_1", targetId: "mem_2", type: "related", createdAt: "2026-01-01" };
      await kv.set("mem:relations", "rel_legacy", relation);
      await kv.set("mem:obs:ses_1", "obs_1", { ...testObs, executionAgentId: "worker-1", executionAgentType: "Explore" });
      const created = await sdk.trigger("mem::snapshot-create", {});
      expect(created.success).toBe(true);
      await kv.delete("mem:relations", "rel_legacy");
      await kv.set("mem:obs:ses_1", "obs_1", testObs);
      await kv.set("mem:relations", "rel_stale", { ...relation, targetId: "stale" });
      expect(await sdk.trigger("mem::snapshot-restore", { commitHash: created.snapshot.commitHash })).toMatchObject({ success: true });
      expect(await kv.list("mem:relations")).toEqual([relation]);
      expect(await kv.get("mem:relations", "rel_legacy")).toEqual(relation);
      const restored = await sdk.trigger("mem::export", {}) as ExportData;
      expect(restored.observations["ses_1"][0]).toMatchObject({ executionAgentId: "worker-1", executionAgentType: "Explore" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["export", "snapshot"] as const)("preserves a recovered Session and its Observation in a fresh %s restore", async (kind) => {
    await kv.delete("mem:summaries", testSession.id);
    registerEvictFunction(sdk as never, kv as never);
    registerEventTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::summarize", async () => {
      await kv.set("mem:summaries", testSession.id, testSummary);
      return { success: true, summary: testSummary };
    });
    await sdk.trigger("mem::evict", {});
    const exported = await sdk.trigger("mem::export", {}) as ExportData;
    expect.soft(exported.sessions).toContainEqual(testSession);
    expect.soft(exported.observations[testSession.id] ?? []).toContainEqual(testObs);

    mkdirSync("tmp", { recursive: true });
    const dir = mkdtempSync(join(process.cwd(), "tmp", "snapshot-recovered-"));
    try {
      registerSnapshotFunction(sdk as never, kv as never, dir);
      const created = await sdk.trigger("mem::snapshot-create", {});
      expect(created.success).toBe(true);
        const freshKv = mockKV();
        const freshSdk = mockSdk();
        registerExportImportFunction(freshSdk as never, freshKv as never);
        registerSnapshotFunction(freshSdk as never, freshKv as never, dir);
        registerSearchFunction(freshSdk as never, freshKv as never);
        const result = kind === "export"
          ? await freshSdk.trigger("mem::import", { exportData: structuredClone(exported), strategy: "replace" })
          : await freshSdk.trigger("mem::snapshot-restore", { commitHash: created.snapshot.commitHash });
        expect(result.success).toBe(true);
        expect.soft(await freshKv.get("mem:sessions", testSession.id)).toEqual(testSession);
        expect.soft(await freshKv.get("mem:obs:ses_1", testObs.id)).toMatchObject({ id: "obs_1", sessionId: "ses_1", title: "Edit auth" });
        getSearchIndex().clear();
        await rebuildIndex(freshKv as never);
        const own = await freshSdk.trigger("mem::search", { query: "auth", project: "my-project" });
        const other = await freshSdk.trigger("mem::search", { query: "auth", project: "other-project" });
        expect.soft(own.results.map((r: { observation: CompressedObservation }) => r.observation.id)).toContain(testObs.id);
        expect.soft(other.results.map((r: { observation: CompressedObservation }) => r.observation.id)).not.toContain(testObs.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("export then import round-trip preserves data", async () => {
    const exported = (await sdk.trigger("mem::export", {})) as ExportData;

    const freshKv = mockKV();
    const freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);

    const importResult = (await freshSdk.trigger("mem::import", {
      exportData: exported,
      strategy: "merge",
    })) as {
      success: boolean;
      sessions: number;
      observations: number;
      memories: number;
    };

    expect(importResult.success).toBe(true);
    expect(importResult.sessions).toBe(1);
    expect(importResult.observations).toBe(1);
    expect(importResult.memories).toBe(1);

    const reExported = (await freshSdk.trigger(
      "mem::export",
      {},
    )) as ExportData;
    expect(reExported.sessions.length).toBe(exported.sessions.length);
    expect(reExported.memories.length).toBe(exported.memories.length);
  });

  it("import bounds the provenance of a graph node written before the cap", async () => {
    // #3: an export taken before the write-time bound carries unbounded
    // provenance. The startup repair has already stamped its version by the
    // time anyone imports, so the cap has to be applied on the way in.
    process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"] = "2";
    process.env["GRAPH_EXTRACTION_ENABLED"] = "true";
    try {
      const exportData = {
        version: VERSION,
        exportedAt: new Date().toISOString(),
        sessions: [],
        observations: {},
        memories: [],
        summaries: [],
        graphNodes: [
          {
            id: "gnode_1",
            name: "auth",
            type: "concept",
            sourceObservationIds: ["o1", "o2", "o3", "o4"],
          },
        ],
      } as unknown as ExportData;

      await sdk.trigger("mem::import", { exportData, strategy: "merge" });

      const node = (await kv.get("mem:graph:nodes", "gnode_1")) as {
        sourceObservationIds: string[];
      };
      expect(node.sourceObservationIds).toEqual(["o3", "o4"]);
    } finally {
      delete process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"];
      delete process.env["GRAPH_EXTRACTION_ENABLED"];
    }
  });

  it("import rejects unsupported version", async () => {
    const exportData = {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    } as unknown as ExportData;

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported export version");
  });

  describe("replace leaves the store untouched when the file is invalid (#436)", () => {
    const base = (): ExportData => ({
      version: VERSION,
      exportedAt: "2026-03-01T00:00:00Z",
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    });

    it.each([
      ["relations are malformed", { relations: [{ key: "rel_1", value: null }] }],
      ["accessLogs is not an array", { accessLogs: {} }],
      ["lessons is not an array", { lessons: {} }],
      ["insights is not an array", { insights: "x" }],
      ["accessLogs exceeds its limit", { accessLogs: Array(50_001).fill({}) }],
      ["memory content is not text", { memories: [{ ...testMemory, content: 42 }] }],
      ["memory concepts contain a non-string", { memories: [{ ...testMemory, concepts: [null] }] }],
      ["memory sessionIds contain a non-string", { memories: [{ ...testMemory, sessionIds: [3] }] }],
      ["observation facts are not an array", { observations: { ses_2: [{ ...testObs, facts: {} }] } }],
      ["observation narrative is not text", { observations: { ses_2: [{ ...testObs, narrative: 42 }] } }],
      ["graph node provenance is malformed", { graphNodes: [{ id: "node", name: "Node", sourceObservationIds: [3] }] }],
      ["graph edge endpoint is malformed", { graphEdges: [{ id: "edge", sourceNodeId: {}, targetNodeId: "node" }] }],
    ])("%s", async (_label, patch) => {
      const result = (await sdk.trigger("mem::import", {
        exportData: { ...base(), ...patch },
        strategy: "replace",
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(await kv.get("mem:sessions", "ses_1")).toEqual(testSession);
      expect(await kv.get("mem:obs:ses_1", "obs_1")).not.toBeNull();
      expect(await kv.get("mem:memories", "mem_1")).not.toBeNull();
      expect(await kv.get("mem:summaries", "ses_1")).toEqual(testSummary);
    });

    it.each(["merge", "skip"] as const)("validates before writes with %s", async (strategy) => {
      const result = await sdk.trigger("mem::import", {
        exportData: { ...base(), sessions: [{ ...testSession, id: "new" }], memories: [{ ...testMemory, files: 5 }] },
        strategy,
      });
      expect(result).toMatchObject({ success: false });
      expect(await kv.get("mem:sessions", "new")).toBeNull();
      expect(await kv.get("mem:memories", "mem_1")).toEqual(testMemory);
    });

    it.each(["merge", "skip", "replace"] as const)("keeps legacy normalization with %s", async (strategy) => {
      const result = await sdk.trigger("mem::import", {
        exportData: {
          ...base(),
          sessions: [{ status: "completed" }],
          memories: [{ ...testMemory, id: "legacy", sessionIds: "old" }],
          accessLogs: [{ memoryId: "legacy", count: "old", recent: [1, "old"] }],
        },
        strategy,
      });
      expect(result).toMatchObject({ success: true, invalid: 1 });
      expect(await kv.get("mem:memories", "legacy")).toMatchObject({ sessionIds: [] });
      expect(await kv.get("mem:access", "legacy")).toMatchObject({ count: 1, recent: [1] });
    });

    it("drops rows without their key and restores the rest", async () => {
      const keyless = { endedAt: "2026-09-22T01:02:26.889Z", status: "completed" };
      const result = (await sdk.trigger("mem::import", {
        exportData: {
          ...base(),
          sessions: [keyless, { ...testSession, id: "ses_2" }],
          observations: { ses_2: ["oops", { ...testObs, id: "obs_2", sessionId: "ses_2" }] },
          memories: [null, { ...testMemory, id: "mem_2" }],
          lessons: [{ content: "no id" }],
        },
        strategy: "replace",
      })) as { success: boolean; invalid: number; sessions: number };

      expect(result).toMatchObject({ success: true, invalid: 4, sessions: 1 });
      expect(await kv.get("mem:sessions", "ses_1")).toBeNull();
      expect(await kv.get("mem:sessions", "ses_2")).not.toBeNull();
      expect(await kv.get("mem:obs:ses_2", "obs_2")).not.toBeNull();
      expect(await kv.get("mem:memories", "mem_2")).not.toBeNull();
    });
  });
});
