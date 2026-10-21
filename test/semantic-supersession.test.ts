import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  getConsolidationDecayDays: () => 30,
  getConsolidatedMemoryForgetDays: () => 180,
  isConsolidationEnabled: vi.fn(() => true),
}));

import { registerConsolidationPipelineFunction } from "../src/functions/consolidation-pipeline.js";
import { recallSemanticFacts } from "../src/functions/semantic-recall.js";
import { KV } from "../src/state/schema.js";
import type { SessionSummary, SemanticMemory, AuditEntry } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const scope = (s: string) => {
    if (!store.has(s)) store.set(s, new Map());
    return store.get(s)!;
  };
  return {
    get: async <T>(s: string, k: string) => (scope(s).get(k) as T) ?? null,
    set: async <T>(s: string, k: string, v: T) => (scope(s).set(k, v), v),
    setMany: async () => 0,
    delete: async (s: string, k: string) => void scope(s).delete(k),
    deleteManyIfUnchanged: async () => [] as string[],
    list: async <T>(s: string) => Array.from(scope(s).values()) as T[],
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string | { id: string }, h: Function) =>
      void fns.set(typeof id === "string" ? id : id.id, h),
    registerTrigger: () => {},
    trigger: async (id: string, data?: unknown) => fns.get(id)!(data),
  };
}

function summary(i: number): SessionSummary {
  return {
    sessionId: `ses_${i}`,
    project: "proj",
    createdAt: new Date(Date.now() - i * 86400000).toISOString(),
    title: `Session ${i}`,
    narrative: `Worked on ${i}`,
    keyDecisions: [],
    filesModified: [],
    concepts: ["style"],
    observationCount: 3,
  };
}

const keyed = (attrs: string, text: string) =>
  `<facts><fact confidence="0.8" ${attrs}>${text}</fact></facts>`;

describe("Semantic Fact keyed supersession", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;
  let reply: string;

  async function consolidate(response: string) {
    reply = response;
    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic", project: "proj" });
  }
  const facts = () => kv.list<SemanticMemory>(KV.semantic);

  beforeEach(async () => {
    kv = mockKV();
    sdk = mockSdk();
    const provider = { name: "t", compress: vi.fn(), summarize: vi.fn(async () => reply) };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    for (let i = 0; i < 5; i++) await kv.set(KV.summaries, `ses_${i}`, summary(i));
  });

  it("closes a live fact when the same subject and relation arrive with a different object", async () => {
    await consolidate(keyed(`subject="Indentation" relation="Style" object="tabs"`, "The team indents with tabs"));
    await consolidate(keyed(`subject=" indentation" relation="style " object="Spaces"`, "The team indents with spaces"));

    const all = await facts();
    const stale = all.find((f) => f.fact.includes("tabs"))!;
    const fresh = all.find((f) => f.fact.includes("spaces"))!;
    expect(stale.isLatest).toBe(false);
    expect(stale.supersededBy).toBe(fresh.id);
    expect(fresh.isLatest).toBeUndefined();

    const audits = await kv.list<AuditEntry>(KV.audit);
    expect(
      audits.some((a) => a.targetIds.includes(stale.id) && a.details?.event === "semantic.supersede"),
    ).toBe(true);
  });

  it("recall excludes the superseded fact", async () => {
    await consolidate(keyed(`subject="indentation" relation="style" object="tabs"`, "The team indents with tabs"));
    await consolidate(keyed(`subject="indentation" relation="style" object="spaces"`, "The team indents with spaces"));
    const recalled = await recallSemanticFacts(kv as never, 10, { query: "indents" });
    expect(recalled.map((r) => r.fact.fact)).toEqual(["The team indents with spaces"]);
  });

  it("reinforces when the key and object match but the wording differs", async () => {
    await consolidate(keyed(`subject="indentation" relation="style" object="tabs"`, "The team indents with tabs"));
    await consolidate(keyed(`subject="indentation" relation="style" object="TABS"`, "Tabs are used for indentation"));
    const all = await facts();
    expect(all).toHaveLength(1);
    expect(all[0].accessCount).toBe(2);
    expect(all[0].isLatest).toBeUndefined();
  });

  it("does not supersede across a different subject or relation", async () => {
    await consolidate(keyed(`subject="indentation" relation="style" object="tabs"`, "The team indents with tabs"));
    await consolidate(keyed(`subject="line endings" relation="style" object="lf"`, "Line endings are LF"));
    await consolidate(keyed(`subject="indentation" relation="width" object="4"`, "Indent width is 4"));
    const all = await facts();
    expect(all).toHaveLength(3);
    expect(all.every((f) => f.isLatest !== false)).toBe(true);
  });

  it("leaves unkeyed facts alone", async () => {
    await consolidate(`<facts><fact confidence="0.8">The team indents with tabs</fact></facts>`);
    await consolidate(keyed(`subject="indentation" relation="style" object="spaces"`, "The team indents with spaces"));
    const all = await facts();
    expect(all).toHaveLength(2);
    expect(all.every((f) => f.isLatest !== false)).toBe(true);
  });

  it("keys an unkeyed fact its text matches, so a later object closes it", async () => {
    await consolidate(`<facts><fact confidence="0.8">The team indents with tabs</fact></facts>`);
    await consolidate(keyed(`subject="indentation" relation="style" object="tabs"`, "The team indents with tabs"));
    await consolidate(keyed(`subject="indentation" relation="style" object="spaces"`, "The team indents with spaces"));

    const all = await facts();
    const stale = all.find((f) => f.fact.includes("tabs"))!;
    expect(stale).toMatchObject({ subject: "indentation", project: "proj", isLatest: false });
    expect(all).toHaveLength(2);
  });

  it("does not supersede a fact from another project", async () => {
    const other: SemanticMemory = {
      id: "sem_other",
      fact: "Other repo indents with tabs",
      confidence: 0.8,
      sourceSessionIds: [],
      sourceMemoryIds: [],
      accessCount: 1,
      lastAccessedAt: "",
      strength: 0.8,
      createdAt: "",
      updatedAt: "",
      project: "other",
      subject: "indentation",
      relation: "style",
      object: "tabs",
    };
    await kv.set(KV.semantic, "sem_other", other);
    await consolidate(keyed(`subject="indentation" relation="style" object="spaces"`, "The team indents with spaces"));
    expect(((await kv.get(KV.semantic, "sem_other")) as SemanticMemory).isLatest).toBeUndefined();
  });
});

describe("recallSemanticFacts project scope", () => {
  it("a newer overlapping fact in another project does not demote this project's fact", async () => {
    const kv = mockKV();
    const session = (id: string, project: string) =>
      kv.set(KV.sessions, id, { id, project, startedAt: "2026-09-01T00:00:00.000Z", status: "completed", observationCount: 0 });
    await session("ses_mine", "proj-a");
    await session("ses_other", "proj-b");
    const fact = (id: string, text: string, ses: string, at: string): SemanticMemory => ({
      id, fact: text, confidence: 0.8, sourceSessionIds: [ses], sourceMemoryIds: [],
      accessCount: 1, lastAccessedAt: at, strength: 0.8, createdAt: at, updatedAt: at,
    });
    await kv.set(KV.semantic, "sem_mine", fact("sem_mine", "The team agreed to indent with tabs", "ses_mine", "2026-09-01T10:00:00.000Z"));
    await kv.set(KV.semantic, "sem_other", fact("sem_other", "The team agreed to indent with spaces", "ses_other", "2026-10-10T10:00:00.000Z"));

    const recalled = await recallSemanticFacts(kv as never, 10, { query: "agreed indent", project: "proj-a" });
    expect(recalled.map((r) => r.fact.id)).toEqual(["sem_mine"]);
    expect(recalled[0].score).toBeCloseTo(0.8);
  });

  it("a stale fact reinforced after the correction still ranks behind it", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses", { id: "ses", project: "proj-a", startedAt: "2026-09-01T00:00:00.000Z", status: "completed", observationCount: 0 });
    const fact = (id: string, text: string, created: string, updated: string, confidence: number): SemanticMemory => ({
      id, fact: text, confidence, sourceSessionIds: ["ses"], sourceMemoryIds: [],
      accessCount: 1, lastAccessedAt: updated, strength: confidence, createdAt: created, updatedAt: updated,
    });
    await kv.set(KV.semantic, "stale", fact("stale", "The team agreed to indent with tabs", "2026-09-01T10:00:00.000Z", "2026-10-15T10:00:00.000Z", 0.9));
    await kv.set(KV.semantic, "fresh", fact("fresh", "The team agreed to indent with spaces", "2026-10-10T10:00:00.000Z", "2026-10-10T10:00:00.000Z", 0.7));

    const recalled = await recallSemanticFacts(kv as never, 10, { query: "agreed indent", project: "proj-a" });
    expect(recalled.map((r) => r.fact.id)).toEqual(["fresh", "stale"]);
  });
});
