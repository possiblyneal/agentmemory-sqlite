import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerReflectFunctions } from "../src/functions/reflect.js";
import { recordProjectActivity } from "../src/state/project-time.js";
import { indexGraphEdge, indexGraphNode, markGraphIndexesReady } from "../src/state/graph-indexes.js";
import type { Insight, GraphNode, GraphEdge, SemanticMemory, Lesson, Crystal } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const setManyCalls: Array<{ scope: string; keys: string[] }> = [];
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    setMany: async <T>(scope: string, entries: Array<{ key: string; value: T }>): Promise<number> => {
      setManyCalls.push({ scope, keys: entries.map((e) => e.key) });
      for (const e of entries) {
        if (!store.has(scope)) store.set(scope, new Map());
        store.get(scope)!.set(e.key, e.value);
      }
      return entries.length;
    },
    setManyCalls,
    setManyIfUnchanged: async <T>(
      scope: string,
      entries: Array<{ key: string; value: T; updatedAt: string }>,
    ): Promise<string[]> => {
      const written: string[] = [];
      for (const { key, value, updatedAt } of entries) {
        const row = store.get(scope)?.get(key) as { updatedAt?: string } | undefined;
        if (row?.updatedAt !== updatedAt) continue;
        store.get(scope)!.set(key, value);
        written.push(key);
      }
      return written;
    },
    deleteManyIfUnchanged: async (
      scope: string,
      entries: Array<{ key: string; updatedAt: string }>,
    ): Promise<string[]> => {
      const deleted: string[] = [];
      for (const { key, updatedAt } of entries) {
        const row = store.get(scope)?.get(key) as { updatedAt?: string } | undefined;
        if (row?.updatedAt !== updatedAt) continue;
        store.get(scope)!.delete(key);
        deleted.push(key);
      }
      return deleted;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (structuredClone(Array.from(entries.values())) as T[]) : [];
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

function makeConceptNode(name: string): GraphNode {
  return {
    id: `node_${name}`,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: [],
    createdAt: "2026-04-01T00:00:00Z",
  };
}

function makeEdge(src: string, tgt: string): GraphEdge {
  return {
    id: `edge_${src}_${tgt}`,
    type: "related_to",
    sourceNodeId: `node_${src}`,
    targetNodeId: `node_${tgt}`,
    weight: 1,
    sourceObservationIds: [],
    createdAt: "2026-04-01T00:00:00Z",
  };
}

async function seedNode(kv: ReturnType<typeof mockKV>, node: GraphNode): Promise<void> {
  await kv.set("mem:graph:nodes", node.id, node);
  await indexGraphNode(kv as never, node);
}

async function seedEdge(kv: ReturnType<typeof mockKV>, edge: GraphEdge): Promise<void> {
  await kv.set("mem:graph:edges", edge.id, edge);
  await indexGraphEdge(kv as never, edge);
}

function makeSemantic(fact: string, id?: string): SemanticMemory {
  return {
    id: id || `sem_${fact.slice(0, 8)}`,
    fact,
    confidence: 0.8,
    sourceSessionIds: [],
    sourceMemoryIds: [],
    accessCount: 1,
    lastAccessedAt: "2026-04-01T00:00:00Z",
    strength: 0.8,
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
  };
}

function makeLesson(content: string, tags: string[]): Lesson {
  return {
    id: `lsn_${content.slice(0, 8)}`,
    content,
    context: "",
    confidence: 0.7,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    tags,
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    decayRate: 0.05,
  };
}

function makeCrystal(narrative: string, lessons: string[]): Crystal {
  return {
    id: `crys_${narrative.slice(0, 8)}`,
    narrative,
    keyOutcomes: [],
    filesAffected: [],
    lessons,
    sourceActionIds: [],
    createdAt: "2026-04-01T00:00:00Z",
  };
}

const XML_RESPONSE = `<insights>
<insight confidence="0.85" title="Defense in Depth">
Security requires layered protection: input validation, safe APIs, and deny-lists together.
</insight>
<insight confidence="0.7" title="Testing at Boundaries">
Focus test effort on system boundaries where trust transitions occur.
</insight>
</insights>`;

describe("Reflect", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let provider: { name: string; compress: ReturnType<typeof vi.fn>; summarize: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    void markGraphIndexesReady(kv as never);
    provider = {
      name: "test",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(XML_RESPONSE),
    };
    registerReflectFunctions(sdk as never, kv as never, provider as never);
  });

  describe("mem::reflect", () => {
    it("reads the graph through the indexes, never a full scope list", async () => {
      await seedNode(kv, makeConceptNode("security"));
      await seedNode(kv, makeConceptNode("validation"));
      await seedEdge(kv, makeEdge("security", "validation"));
      const listed: string[] = [];
      const list = kv.list;
      kv.list = async <T>(scope: string) => {
        listed.push(scope);
        return list<T>(scope);
      };

      await sdk.trigger("mem::reflect", {});

      expect(listed).not.toContain("mem:graph:nodes");
      expect(listed).not.toContain("mem:graph:edges");
    });

    it("clusters nothing from the graph while its indexes are unarmed", async () => {
      const unarmed = mockKV();
      const unarmedSdk = mockSdk();
      registerReflectFunctions(unarmedSdk as never, unarmed as never, provider as never);
      await unarmed.set("mem:graph:nodes", "node_a", makeConceptNode("a"));
      await unarmed.set("mem:graph:nodes", "node_b", makeConceptNode("b"));
      await unarmed.set("mem:graph:edges", "e", makeEdge("a", "b"));

      const result = (await unarmedSdk.trigger("mem::reflect", {})) as { usedFallback?: boolean; clustersProcessed: number };

      expect(provider.summarize).not.toHaveBeenCalled();
      expect(result.clustersProcessed).toBe(0);
    });

    it("returns empty when no graph nodes or memories exist", async () => {
      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        newInsights: number;
        clustersProcessed: number;
      };

      expect(result.success).toBe(true);
      expect(result.newInsights).toBe(0);
      expect(result.clustersProcessed).toBe(0);
    });

    it("synthesizes insights from graph concept clusters", async () => {
      await seedNode(kv, makeConceptNode("security"));
      await seedNode(kv, makeConceptNode("validation"));
      await seedNode(kv, makeConceptNode("testing"));
      await seedEdge(kv, makeEdge("security", "validation"));
      await seedEdge(kv, makeEdge("security", "testing"));

      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection attacks"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use execFile for security", ["security"]));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        newInsights: number;
      };

      expect(result.success).toBe(true);
      expect(result.newInsights).toBe(2);
      expect(provider.summarize).toHaveBeenCalled();

      const insights = await kv.list<Insight>("mem:insights");
      expect(insights.length).toBe(2);
      expect(insights[0].title).toBeTruthy();
      expect(insights[0].sourceConceptCluster.length).toBeGreaterThan(0);
    });

    it("keeps seeding clusters past a seed an earlier cluster already absorbed (#1133)", async () => {
      for (const name of ["auth", "token", "session", "cookie", "expiry", "deploy", "docker", "helm"]) {
        await seedNode(kv, makeConceptNode(name));
      }
      const edges: Array<[string, string]> = [
        ["auth", "token"], ["auth", "session"], ["auth", "cookie"],
        ["token", "expiry"], ["token", "session"],
        ["deploy", "docker"], ["deploy", "helm"],
      ];
      for (const [src, tgt] of edges) {
        await seedEdge(kv, makeEdge(src, tgt));
      }

      const result = (await sdk.trigger("mem::reflect", {})) as {
        clustersProcessed: number;
        clustersSkipped: number;
      };

      expect(result.clustersProcessed + result.clustersSkipped).toBe(2);
    });

    it("never puts a concept in two clusters (#1133)", async () => {
      const chain = ["c1", "c2", "c3", "c4", "c5", "c6"];
      for (const name of chain) {
        await seedNode(kv, makeConceptNode(name));
      }
      for (let i = 0; i < chain.length - 1; i++) {
        await seedEdge(kv, makeEdge(chain[i]!, chain[i + 1]!));
      }
      for (let i = 0; i < 3; i++) {
        await kv.set("mem:semantic", `sem_${i}`, makeSemantic(`c3 and c4 fact ${i}`));
      }

      const result = (await sdk.trigger("mem::reflect", {})) as {
        clustersProcessed: number;
        clustersSkipped: number;
      };

      expect(result.clustersProcessed).toBe(1);
      expect(result.clustersSkipped).toBe(1);
    });

    it("skips clusters with fewer than 3 supporting items", async () => {
      await seedNode(kv, makeConceptNode("sparse"));
      await seedNode(kv, makeConceptNode("topic"));
      await seedEdge(kv, makeEdge("sparse", "topic"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("One sparse fact"));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        clustersSkipped: number;
        newInsights: number;
      };

      expect(result.clustersSkipped).toBe(1);
      expect(result.newInsights).toBe(0);
      expect(provider.summarize).not.toHaveBeenCalled();
    });

    it("fits a large cluster to its prompt budget, lessons first then the strongest facts", async () => {
      await seedNode(kv, makeConceptNode("security"));
      await seedNode(kv, makeConceptNode("validation"));
      await seedEdge(kv, makeEdge("security", "validation"));
      for (let i = 0; i < 300; i++) {
        await kv.set("mem:semantic", `sem_${i}`, {
          ...makeSemantic(`security fact ${i} ${"x".repeat(400)}`, `sem_${i}`),
          confidence: i / 300,
        });
      }
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use execFile for security", ["security"]));

      await sdk.trigger("mem::reflect", {});

      const prompt = String(provider.summarize.mock.calls[0]![1]);
      expect(prompt.length).toBeLessThanOrEqual(24_000);
      expect(prompt).toContain("Use execFile for security");
      expect(prompt).toContain("security fact 299 ");
      expect(prompt).not.toContain("security fact 0 ");
      const [insight] = await kv.list<Insight>("mem:insights");
      expect(insight!.sourceMemoryIds).toContain("sem_299");
      expect(insight!.sourceMemoryIds).not.toContain("sem_0");
    });

    it("writes at most 100 source Memory ids per Insight however many facts fit the prompt", async () => {
      await seedNode(kv, makeConceptNode("security"));
      await seedNode(kv, makeConceptNode("validation"));
      await seedEdge(kv, makeEdge("security", "validation"));
      for (let i = 0; i < 300; i++) {
        await kv.set("mem:semantic", `sem_${i}`, {
          ...makeSemantic(`security fact ${i}`, `sem_${i}`),
          confidence: i / 300,
        });
      }

      await sdk.trigger("mem::reflect", {});

      const [insight] = await kv.list<Insight>("mem:insights");
      expect(insight!.sourceMemoryIds).toHaveLength(100);
      expect(insight!.sourceMemoryIds).toContain("sem_299");
    });

    it("skips a cluster left with fewer than 3 items after fitting its budget", async () => {
      await seedNode(kv, makeConceptNode("security"));
      await seedNode(kv, makeConceptNode("validation"));
      await seedEdge(kv, makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_small", makeSemantic("security fact small", "sem_small"));
      for (let i = 0; i < 3; i++) {
        await kv.set("mem:semantic", `sem_big_${i}`, makeSemantic(`security fact ${i} ${"x".repeat(30_000)}`, `sem_big_${i}`));
      }

      const result = (await sdk.trigger("mem::reflect", {})) as { clustersSkipped: number };

      expect(result.clustersSkipped).toBe(1);
      expect(provider.summarize).not.toHaveBeenCalled();
    });

    it("fills the budget with the newest crystals first", async () => {
      await seedNode(kv, makeConceptNode("security"));
      await seedNode(kv, makeConceptNode("validation"));
      await seedEdge(kv, makeEdge("security", "validation"));
      for (let i = 0; i < 100; i++) {
        await kv.set("mem:crystals", `crys_${i}`, {
          ...makeCrystal(`crystal ${i} ${"y".repeat(400)}`, ["security matters"]),
          id: `crys_${i}`,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        });
      }

      await sdk.trigger("mem::reflect", {});

      const prompt = String(provider.summarize.mock.calls[0]![1]);
      expect(prompt).toContain("crystal 99 ");
      expect(prompt).not.toContain("crystal 0 ");
    });

    it("deduplicates insights by fingerprint", async () => {
      await seedNode(kv, makeConceptNode("security"));
      await seedNode(kv, makeConceptNode("validation"));
      await seedEdge(kv, makeEdge("security", "validation"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("Always validate security inputs"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("Testing improves security coverage"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("Validation prevents injection"));

      await sdk.trigger("mem::reflect", {});
      const first = await kv.list<Insight>("mem:insights");
      expect(first.length).toBe(2);

      const result = (await sdk.trigger("mem::reflect", {})) as {
        reinforced: number;
        newInsights: number;
      };

      expect(result.reinforced).toBe(2);
      expect(result.newInsights).toBe(0);

      const after = await kv.list<Insight>("mem:insights");
      expect(after.length).toBe(2);
      expect(after[0].reinforcements).toBe(1);
    });

    it("falls back to Jaccard grouping when graph is empty", async () => {
      await kv.set("mem:semantic", "sem_1", makeSemantic("security validation is important"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("security testing prevents bugs"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("validation testing framework"));
      await kv.set("mem:lessons", "lsn_1", makeLesson("Use security headers", ["security", "validation"]));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        usedFallback: boolean;
      };

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
    });

    it("handles LLM failure gracefully", async () => {
      provider.summarize.mockRejectedValue(new Error("LLM timeout"));

      await seedNode(kv, makeConceptNode("concept_a"));
      await seedNode(kv, makeConceptNode("concept_b"));
      await seedEdge(kv, makeEdge("concept_a", "concept_b"));
      await kv.set("mem:semantic", "sem_1", makeSemantic("fact about concept_a"));
      await kv.set("mem:semantic", "sem_2", makeSemantic("fact about concept_b"));
      await kv.set("mem:semantic", "sem_3", makeSemantic("concept_a and concept_b together"));

      const result = (await sdk.trigger("mem::reflect", {})) as {
        success: boolean;
        newInsights: number;
      };

      expect(result.success).toBe(true);
      expect(result.newInsights).toBe(0);
    });
  });

  describe("mem::insight-list", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      await kv.set("mem:insights", "ins_1", {
        id: "ins_1", title: "Insight A", content: "Content A", confidence: 0.9,
        reinforcements: 2, sourceConceptCluster: ["security"], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], project: "/app",
        tags: ["security"], createdAt: now, updatedAt: now, decayRate: 0.05,
      });
      await kv.set("mem:insights", "ins_2", {
        id: "ins_2", title: "Insight B", content: "Content B", confidence: 0.4,
        reinforcements: 0, sourceConceptCluster: ["testing"], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], project: "/other",
        tags: ["testing"], createdAt: now, updatedAt: now, decayRate: 0.05,
      });
    });

    it("lists all non-deleted insights sorted by confidence", async () => {
      const result = (await sdk.trigger("mem::insight-list", {})) as { insights: Insight[] };
      expect(result.insights.length).toBe(2);
      expect(result.insights[0].confidence).toBe(0.9);
    });

    it("filters by project", async () => {
      const result = (await sdk.trigger("mem::insight-list", { project: "/app" })) as { insights: Insight[] };
      expect(result.insights.length).toBe(1);
    });

    it("filters by minConfidence", async () => {
      const result = (await sdk.trigger("mem::insight-list", { minConfidence: 0.5 })) as { insights: Insight[] };
      expect(result.insights.length).toBe(1);
    });

    it("reports the filtered total beyond the limit", async () => {
      const result = (await sdk.trigger("mem::insight-list", { limit: 1 })) as { insights: Insight[]; total: number };
      expect(result.insights.length).toBe(1);
      expect(result.total).toBe(2);
    });

    it("reports the total after filtering", async () => {
      const result = (await sdk.trigger("mem::insight-list", { minConfidence: 0.5 })) as { total: number };
      expect(result.total).toBe(1);
    });
  });

  describe("mem::insight-search", () => {
    beforeEach(async () => {
      const now = new Date().toISOString();
      await kv.set("mem:insights", "ins_1", {
        id: "ins_1", title: "Defense in Depth", content: "Security requires layered protection",
        confidence: 0.85, reinforcements: 1, sourceConceptCluster: ["security"],
        sourceMemoryIds: [], sourceLessonIds: [], sourceCrystalIds: [],
        tags: ["security"], createdAt: now, updatedAt: now, decayRate: 0.05,
      });
    });

    it("finds insights matching query", async () => {
      const result = (await sdk.trigger("mem::insight-search", {
        query: "security layered protection",
      })) as { insights: Array<Insight & { score: number }> };

      expect(result.insights.length).toBe(1);
      expect(result.insights[0].title).toBe("Defense in Depth");
    });

    it("rejects empty query", async () => {
      const result = (await sdk.trigger("mem::insight-search", { query: "" })) as { success: boolean };
      expect(result.success).toBe(false);
    });
  });

  describe("mem::insight-decay-sweep", () => {
    beforeEach(async () => {
      await recordProjectActivity(kv as never, "/active", new Date().toISOString());
    });

    it("decays old insights incrementally", async () => {
      await kv.set("mem:insights", "ins_old", {
        id: "ins_old", title: "Old", content: "Old insight", confidence: 0.8,
        reinforcements: 1, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [],
        createdAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        decayRate: 0.05,
      });

      const result = (await sdk.trigger("mem::insight-decay-sweep", {})) as { decayed: number };
      expect(result.decayed).toBe(1);

      const after = await kv.get<Insight>("mem:insights", "ins_old");
      expect(after!.confidence).toBeLessThan(0.8);
      expect(after!.lastDecayedAt).toBeDefined();
    });

    it("keeps a concurrent reinforcement and does not count the skipped row", async () => {
      const old = new Date(Date.now() - 21 * 86400000).toISOString();
      const row = {
        id: "ins_race", title: "Race", content: "Race", confidence: 0.8,
        reinforcements: 1, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [],
        createdAt: old, updatedAt: old, decayRate: 0.05,
      };
      await kv.set("mem:insights", "ins_race", { ...row });
      const list = kv.list;
      kv.list = (async (scope: string) => {
        const snapshot = (await list(scope)).map((r) => ({ ...(r as object) }));
        if (scope === "mem:insights") {
          await kv.set(scope, "ins_race", {
            ...row, confidence: 0.95, reinforcements: 2, updatedAt: new Date().toISOString(),
          });
        }
        return snapshot;
      }) as typeof kv.list;

      const result = (await sdk.trigger("mem::insight-decay-sweep", {})) as { decayed: number };

      expect(result.decayed).toBe(0);
      const after = await kv.get<Insight>("mem:insights", "ins_race");
      expect(after!.confidence).toBe(0.95);
      expect(after!.lastDecayedAt).toBeUndefined();
      const [entry] = await kv.list<{ targetIds: string[]; details: Record<string, unknown> }>("mem:audit");
      expect(entry.targetIds).toEqual([]);
      expect(entry.details).toMatchObject({ decayed: 0 });
    });

    it("deletes low-confidence unreinforced insights", async () => {
      await kv.set("mem:insights", "ins_weak", {
        id: "ins_weak", title: "Weak", content: "Weak insight", confidence: 0.12,
        reinforcements: 0, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [],
        createdAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        updatedAt: new Date(Date.now() - 21 * 86400000).toISOString(),
        decayRate: 0.05,
      });

      const result = (await sdk.trigger("mem::insight-decay-sweep", {})) as { deleted: number };
      expect(result.deleted).toBe(1);

      expect(await kv.get<Insight>("mem:insights", "ins_weak")).toBeNull();
    });

    it("deletes insights an earlier sweep only marked deleted", async () => {
      await kv.set("mem:insights", "ins_tombstone", {
        id: "ins_tombstone", title: "Tombstone", content: "Tombstone insight", confidence: 0.1,
        reinforcements: 0, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        decayRate: 0.05,
        deleted: true,
      });

      const result = (await sdk.trigger("mem::insight-decay-sweep", {})) as { deleted: number };
      expect(result.deleted).toBe(1);

      expect(await kv.get<Insight>("mem:insights", "ins_tombstone")).toBeNull();
    });

    it("keeps an Insight reflect rewrote after the sweep read it", async () => {
      const tombstone = {
        id: "ins_regen", title: "Regen", content: "Regen insight", confidence: 0.1,
        reinforcements: 0, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        decayRate: 0.05,
        deleted: true,
      };
      await kv.set("mem:insights", "ins_regen", tombstone);
      const setManyIfUnchanged = kv.setManyIfUnchanged;
      kv.setManyIfUnchanged = async (scope, entries) => {
        await kv.set("mem:insights", "ins_regen", {
          ...tombstone, deleted: undefined, confidence: 0.6, updatedAt: new Date().toISOString(),
        });
        return setManyIfUnchanged(scope, entries);
      };

      const result = (await sdk.trigger("mem::insight-decay-sweep", {})) as { deleted: number };
      expect(result.deleted).toBe(0);

      const after = await kv.get<Insight>("mem:insights", "ins_regen");
      expect(after!.confidence).toBe(0.6);
    });

    it("names the deleted Insights in the audit apart from the decayed ones", async () => {
      const old = new Date(Date.now() - 21 * 86400000).toISOString();
      const base = {
        sourceConceptCluster: [], sourceMemoryIds: [], sourceLessonIds: [], sourceCrystalIds: [],
        tags: [], createdAt: old, updatedAt: old, decayRate: 0.05,
      };
      await kv.set("mem:insights", "ins_keep", {
        ...base, id: "ins_keep", title: "Keep", content: "Keep", confidence: 0.8, reinforcements: 1,
      });
      await kv.set("mem:insights", "ins_drop", {
        ...base, id: "ins_drop", title: "Drop", content: "Drop", confidence: 0.12, reinforcements: 0,
      });

      await sdk.trigger("mem::insight-decay-sweep", {});

      const [entry] = await kv.list<{ targetIds: string[]; details: Record<string, unknown> }>("mem:audit");
      expect(entry.targetIds.sort()).toEqual(["ins_drop", "ins_keep"]);
      expect(entry.details).toMatchObject({ decayed: 1, deleted: 1, deletedIds: ["ins_drop"] });
    });
  });
});

describe("mem::reflect project scope (#1344)", () => {
  it("builds a project's insights only from that project's facts, crystals and concepts", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await markGraphIndexesReady(kv as never);
    const provider = { name: "test", compress: vi.fn(), summarize: vi.fn().mockResolvedValue(XML_RESPONSE) };
    registerReflectFunctions(sdk as never, kv as never, provider as never);
    await kv.set("mem:sessions", "ses_a", { id: "ses_a", project: "alpha" });
    await kv.set("mem:sessions", "ses_b", { id: "ses_b", project: "beta" });
    for (const [name, sessionId] of [["security", "ses_a"], ["validation", "ses_a"], ["beta", "ses_b"]]) {
      await seedNode(kv, { ...makeConceptNode(name), sessionId });
    }
    await seedEdge(kv, makeEdge("security", "validation"));
    await seedEdge(kv, makeEdge("security", "beta"));
    const alphaFacts = ["Always validate security inputs", "Testing improves security coverage", "Validation prevents injection"];
    for (const [i, fact] of alphaFacts.entries()) {
      await kv.set("mem:semantic", `sem_a${i}`, { ...makeSemantic(fact, `sem_a${i}`), sourceSessionIds: ["ses_a"] });
    }
    await kv.set("mem:semantic", "sem_b", { ...makeSemantic("Beta security keys live in vault", "sem_b"), sourceSessionIds: ["ses_b"] });
    await kv.set("mem:crystals", "crys_b", { ...makeCrystal("beta work", ["Beta security rotates weekly"]), project: "beta" });

    await sdk.trigger("mem::reflect", { project: "alpha" });

    expect(provider.summarize).toHaveBeenCalled();
    for (const [, prompt] of provider.summarize.mock.calls) {
      expect(String(prompt)).not.toMatch(/beta/i);
    }
    const insights = await kv.list<Insight>("mem:insights");
    expect(insights.every((i) => i.project === "alpha")).toBe(true);
  });
});
