import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { createFactEntailmentVerifier } from "../src/providers/fact-entailment.js";
import { SqliteState, stateFunctions } from "../src/engine/inproc/state.js";
import { StateKV } from "../src/state/kv.js";

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
import { pagedReads } from "./helpers/mocks.js";

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
    setManyIfUnchanged: async <T>(s: string, entries: Array<{ key: string; value: T; updatedAt: string }>) =>
      entries.filter(({ key, value, updatedAt }) => {
        if ((scope(s).get(key) as { updatedAt?: string } | undefined)?.updatedAt !== updatedAt) return false;
        scope(s).set(key, value);
        return true;
      }).map(({ key }) => key),
    delete: async (s: string, k: string) => void scope(s).delete(k),
    deleteManyIfUnchanged: async () => [] as string[],
    list: async <T>(s: string) => Array.from(scope(s).values()) as T[],
    ...pagedReads(store),
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
    for (let i = 0; i < 5; i++) {
      await kv.set(KV.summaries, `ses_${i}`, summary(i));
      await kv.set(KV.sessions, `ses_${i}`, { id: `ses_${i}`, project: "proj", startedAt: summary(i).createdAt, status: "completed", observationCount: 3 });
    }
  });

  it("merges verified cross-key restatements and recalls alias wording", async () => {
    const provider = { name: "t", compress: vi.fn(), summarize: vi.fn(async () => reply) };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never, async () => true);
    await consolidate(keyed(`subject="service" relation="timeout" object="30 seconds"`, "The service timeout is 30 seconds"));
    await consolidate(keyed(`subject="service" relation="deadline" object="30 seconds"`, "The service deadline timeout is 30 seconds"));
    expect(await facts()).toHaveLength(1);
    expect((await recallSemanticFacts(kv as never, 10, { query: "deadline", project: "proj" })).map(r => r.fact.fact))
      .toEqual(["The service timeout is 30 seconds"]);
    await consolidate(`<facts><fact confidence="0.8">The service deadline timeout is 30 seconds</fact></facts>`);
    expect(await facts()).toHaveLength(1);
  });

  const timeoutFact = keyed(`subject="service" relation="timeout" object="30 seconds"`, "The service timeout is 30 seconds");
  const deadlineFact = keyed(`subject="service" relation="deadline" object="30 seconds"`, "The service deadline timeout is 30 seconds");
  const deadlineAlias = { subject: "service", relation: "deadline", object: "30 seconds", fact: "The service deadline timeout is 30 seconds" };

  it("promotes only the key and wording from an alias", async () => {
    await consolidate(timeoutFact);
    const [row] = await facts();
    const alias = { ...deadlineAlias, project: "other", id: "other-id", isLatest: false };
    await kv.set(KV.semantic, row.id, { ...row, aliases: [alias] });
    await consolidate(keyed(`subject="service" relation="timeout" object="60 seconds"`, "The service timeout is 60 seconds"));
    const retained = await kv.get<SemanticMemory>(KV.semantic, row.id);
    expect(retained).toMatchObject({ id: row.id, project: "proj", ...deadlineAlias });
    expect(retained?.isLatest).not.toBe(false);
  });

  it("keeps the incoming key separate when the verified candidate is superseded during verification", async () => {
    await consolidate(timeoutFact);
    const [row] = await facts();
    const closed = { ...row, isLatest: false, supersededBy: "replacement", updatedAt: "2099-01-01T00:00:00Z" };
    registerConsolidationPipelineFunction(sdk as never, kv as never, { summarize: async () => reply } as never, async () => {
      await kv.set(KV.semantic, row.id, closed);
      return true;
    });
    await consolidate(deadlineFact);
    expect(await facts()).toEqual([closed, expect.objectContaining({ relation: "deadline", project: "proj" })]);
  });

  it("stores a separate Fact when the verifier worker never replies", async () => {
    await consolidate(timeoutFact);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let worker: Worker | undefined;
    try {
      const verify = createFactEntailmentVerifier(resolve("tmp"), () =>
        worker = new Worker(`require('node:worker_threads').parentPort.on('message', () => {})`, { eval: true }));
      const requested = Promise.withResolvers<void>();
      registerConsolidationPipelineFunction(sdk as never, kv as never, { summarize: async () => reply } as never, (left, right) => {
        const result = verify!(left, right);
        requested.resolve();
        return result;
      });
      const pending = consolidate(deadlineFact);
      await requested.promise;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(await facts()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect((await facts()).map(fact => fact.relation)).toEqual(["timeout", "deadline"]);
      await expect(verify!("left", "right")).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
      await worker?.terminate();
    }
  });

  it("skips a malformed candidate object without dropping the incoming Fact", async () => {
    await consolidate(timeoutFact);
    const [row] = await facts();
    await kv.set(KV.semantic, row.id, { ...row, object: 30 });
    const verify = vi.fn(async () => true);
    registerConsolidationPipelineFunction(sdk as never, kv as never, { summarize: async () => reply } as never, verify);
    await consolidate(deadlineFact);
    expect(verify).not.toHaveBeenCalled();
    expect(await facts()).toEqual([expect.objectContaining({ object: 30 }), expect.objectContaining({ relation: "deadline", object: "30 seconds" })]);
  });

  it("does not return a Fact matched only by an alias detached after indexing", async () => {
    await consolidate(timeoutFact);
    const [row] = await facts();
    await kv.set(KV.semantic, row.id, { ...row, aliases: [deadlineAlias] });
    const get = kv.get;
    kv.get = async (scope, key) => {
      if (scope === KV.semantic && key === row.id) {
        await kv.set(KV.semantic, row.id, { ...row, aliases: [] });
      }
      return get(scope, key);
    };
    expect(await recallSemanticFacts(kv as never, 10, { query: "deadline" })).toEqual([]);
    expect((await recallSemanticFacts(kv as never, 10, { query: "timeout" })).map(hit => hit.fact.id)).toEqual([row.id]);
  });

  it.each(["timeout", "deadline"])("detaches an updated %s key without closing the other key", async (changed) => {
    const provider = { name: "t", compress: vi.fn(), summarize: vi.fn(async () => reply) };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never, async () => true);
    await consolidate(keyed(`subject="service" relation="timeout" object="30 seconds"`, "The service timeout is 30 seconds"));
    await consolidate(keyed(`subject="service" relation="deadline" object="30 seconds"`, "The service deadline timeout is 30 seconds"));
    await consolidate(keyed(`subject="service" relation="${changed}" object="60 seconds"`, `The service ${changed} is 60 seconds`));
    const live = (await facts()).filter(f => f.isLatest !== false);
    expect(live).toHaveLength(2);
    expect(live.find(f => f.object === "30 seconds")?.relation).toBe(changed === "timeout" ? "deadline" : "timeout");
    expect(live.find(f => f.object === "60 seconds")?.relation).toBe(changed);
  });

  it.each([
    ["timeout", "The service deadline timeout is 30 seconds"],
    ["deadline", "The service deadline timeout is 30 seconds"],
    ["timeout", "The service timeout is 30 seconds"],
  ])("retains both keys after reopening SQLite, then updates %s (%s)", async (changed, alternateText) => {
    mkdirSync("tmp", { recursive: true });
    const dir = mkdtempSync(join("tmp", "semantic-keys-"));
    const path = join(dir, "state.sqlite");
    let store: SqliteState | undefined;
    function open(verify?: () => Promise<boolean>) {
      store = new SqliteState(path);
      const handlers = stateFunctions(store);
      const db = new StateKV({ trigger: async (req: { function_id: string; payload: unknown }) =>
        handlers[req.function_id](req.payload) } as never);
      sdk = mockSdk();
      registerConsolidationPipelineFunction(sdk as never, db, {
        name: "t", compress: vi.fn(), summarize: async () => reply,
      }, verify);
      return db;
    }
    try {
      const db = open(async () => true);
      for (let i = 0; i < 5; i++) {
        const session = summary(i);
        await db.set(KV.summaries, session.sessionId, session);
        await db.set(KV.sessions, session.sessionId, { project: session.project });
      }
      await consolidate(keyed(`subject="service" relation="timeout" object="30 seconds"`, "The service timeout is 30 seconds"));
      await consolidate(keyed(`subject="service" relation="deadline" object="30 seconds"`, alternateText));
      const [merged] = await db.list<SemanticMemory>(KV.semantic);
      expect(await db.list(KV.semantic)).toHaveLength(1);
      store!.close();
      store = undefined;
      const reopened = open();
      await consolidate(keyed(`subject="service" relation="${changed}" object="60 seconds"`, `The service ${changed} is 60 seconds`));
      const live = (await recallSemanticFacts(reopened, 10, { project: "proj" })).map(hit => hit.fact);
      const retained = changed === "timeout" ? "deadline" : "timeout";
      expect(live).toHaveLength(2);
      expect(live.find(fact => fact.id === merged.id)).toMatchObject({
        relation: retained, object: "30 seconds",
        fact: retained === "deadline" ? alternateText : "The service timeout is 30 seconds",
      });
      expect(live.find(fact => fact.id !== merged.id)).toMatchObject({ relation: changed, object: "60 seconds" });
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ranks a newer correction ahead of a matching stale alias", async () => {
    const base = { confidence: 0.9, updatedAt: "2026-01-01T00:00:00Z", sourceSessionIds: [], sourceMemoryIds: [], accessCount: 1, lastAccessedAt: "2026-01-01T00:00:00Z", strength: 0.9 };
    await kv.set(KV.semantic, "old", { ...base, id: "old", fact: "Gateway timeout retry response window thirty seconds", createdAt: "2026-01-01T00:00:00Z", aliases: [{ subject: "gateway", relation: "deadline", object: "thirty seconds", fact: "Gateway timeout retry response deadline thirty seconds" }] });
    await kv.set(KV.semantic, "new", { ...base, id: "new", fact: "Gateway retry deadline sixty seconds", confidence: 0.8, createdAt: "2026-01-03T00:00:00Z" });
    await kv.set(KV.semantic, "invalid", { ...base, id: "invalid", fact: "Backups run nightly", createdAt: "2026-01-01T00:00:00Z", aliases: { fact: "malformed" } });
    for (const query of ["gateway deadline", "gateway retry"]) {
      expect((await recallSemanticFacts(kv as never, 10, { query })).map(hit => hit.fact.id)).toEqual(["new", "old"]);
    }
  });

  it("preserves distinct keys with identical text when verification is off", async () => {
    await consolidate(keyed(`subject="service" relation="timeout" object="30 seconds"`, "The service timeout is 30 seconds"));
    await consolidate(keyed(`subject="service" relation="deadline" object="30 seconds"`, "The service timeout is 30 seconds"));
    await consolidate(keyed(`subject="service" relation="timeout" object="60 seconds"`, "The service timeout is 60 seconds"));
    expect((await facts()).filter(row => row.isLatest !== false).map(row => [row.relation, row.object]))
      .toEqual([["deadline", "30 seconds"], ["timeout", "60 seconds"]]);
  });

  it("verifies identical text on distinct keys before grouping", async () => {
    const provider = { name: "t", compress: vi.fn(), summarize: vi.fn(async () => reply) };
    const verify = vi.fn(async () => false);
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never, verify);
    await consolidate(keyed(`subject="service" relation="timeout" object="30 seconds"`, "The service timeout is 30 seconds"));
    await consolidate(keyed(`subject="service" relation="deadline" object="30 seconds"`, "The service timeout is 30 seconds"));
    expect(verify).toHaveBeenCalledOnce();
    expect(await facts()).toHaveLength(2);
  });

  it.each(["declines", "throws", "unavailable"])("keeps candidates separate when verification %s", async (mode) => {
    const provider = { name: "t", compress: vi.fn(), summarize: vi.fn(async () => reply) };
    const verifier = mode === "unavailable" ? undefined : async () => { if (mode === "throws") throw new Error("offline"); return false; };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never, verifier);
    await consolidate(keyed(`subject="service" relation="timeout" object="30 seconds"`, "The service timeout is 30 seconds"));
    await consolidate(keyed(`subject="service" relation="deadline" object="30 seconds"`, "The service deadline timeout is 30 seconds"));
    expect(await facts()).toHaveLength(2);
  });

  it("does not verify cross-key candidates from another project", async () => {
    const provider = { name: "t", compress: vi.fn(), summarize: vi.fn(async () => reply) };
    const verify = vi.fn(async () => true);
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never, verify);
    await kv.set(KV.semantic, "other", {
      id: "other", fact: "The service timeout is 30 seconds", project: "other",
      subject: "service", relation: "timeout", object: "30 seconds", confidence: 0.8,
      sourceSessionIds: [], sourceMemoryIds: [], accessCount: 1, lastAccessedAt: "",
      strength: 0.8, createdAt: "", updatedAt: "",
    });
    await consolidate(keyed(`subject="service" relation="deadline" object="30 seconds"`, "The service deadline timeout is 30 seconds"));
    expect(await facts()).toHaveLength(2);
    expect(verify).not.toHaveBeenCalled();
  });

  it("declines ambiguous cross-key candidates", async () => {
    const provider = { name: "t", compress: vi.fn(), summarize: vi.fn(async () => reply) };
    const verify = vi.fn(async () => true);
    await consolidate(keyed(`subject="service" relation="timeout" object="30 seconds"`, "The service timeout is 30 seconds"));
    await consolidate(keyed(`subject="service" relation="deadline" object="30 seconds"`, "The service deadline timeout is 30 seconds"));
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never, verify);
    await consolidate(keyed(`subject="service" relation="limit" object="30 seconds"`, "The service timeout limit is 30 seconds"));
    expect(await facts()).toHaveLength(3);
    expect(verify).not.toHaveBeenCalled();
  });

  it("does not collapse a changed key into a different existing claim", async () => {
    const provider = { name: "t", compress: vi.fn(), summarize: vi.fn(async () => reply) };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never, async () => true);
    await consolidate(keyed(`subject="service" relation="timeout" object="30 seconds"`, "The service timeout is 30 seconds"));
    await consolidate(keyed(`subject="service" relation="deadline" object="60 seconds"`, "The service deadline is 60 seconds"));
    await consolidate(keyed(`subject="service" relation="timeout" object="60 seconds"`, "The service deadline is 60 seconds"));
    const live = (await facts()).filter(f => f.isLatest !== false);
    expect(live).toHaveLength(2);
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

  it("stores reworded unkeyed duplicates separately on the baseline", async () => {
    await consolidate(`<facts><fact confidence="0.8">The service uses a stable timeout</fact></facts>`);
    await consolidate(`<facts><fact confidence="0.8">The service uses the stable timeout</fact></facts>`);
    const recalled = await recallSemanticFacts(kv as never, 10, { query: "service", project: "proj" });
    expect(recalled.map((r) => r.fact.fact)).toEqual(expect.arrayContaining([
      "The service uses a stable timeout", "The service uses the stable timeout",
    ]));
  });

  it.each([
    ["condition", "Deploy the service after tests pass", "Deploy the service before tests pass"],
    ["value", "The service timeout is 30 seconds", "The service timeout is 60 seconds"],
    ["negation", "The service does permit remote access", "The service does not permit remote access"],
    ["time", "The service is available during weekdays", "The service is available during weekends"],
  ])("preserves unkeyed claims that differ by %s", async (_kind, first, second) => {
    await consolidate(`<facts><fact confidence="0.8">${first}</fact></facts>`);
    await consolidate(`<facts><fact confidence="0.8">${second}</fact></facts>`);
    const recalled = await recallSemanticFacts(kv as never, 10, { query: "service", project: "proj" });
    expect(recalled.map((r) => r.fact.fact)).toEqual(expect.arrayContaining([first, second]));
  });

  it("keeps a similar unkeyed fact in another project separate", async () => {
    await kv.set(KV.sessions, "other", { id: "other", project: "other" });
    await kv.set(KV.semantic, "other-fact", {
      id: "other-fact", fact: "The service uses a stable timeout", confidence: 0.8,
      sourceSessionIds: ["other"], sourceMemoryIds: [], accessCount: 1,
      lastAccessedAt: "", strength: 0.8, createdAt: "", updatedAt: "",
    });
    await consolidate(`<facts><fact confidence="0.8">The service uses the stable timeout</fact></facts>`);
    const ours = await recallSemanticFacts(kv as never, 10, { query: "service", project: "proj" });
    const theirs = await recallSemanticFacts(kv as never, 10, { query: "service", project: "other" });
    expect(ours.map((r) => r.fact.fact)).toEqual(["The service uses the stable timeout"]);
    expect(theirs.map((r) => r.fact.fact)).toEqual(["The service uses a stable timeout"]);
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

  it("does not key an unkeyed fact another project's Sessions cite", async () => {
    await kv.set(KV.sessions, "ses_other", { id: "ses_other", project: "other", startedAt: "2026-09-01T00:00:00.000Z", status: "completed", observationCount: 0 });
    const theirs: SemanticMemory = {
      id: "sem_theirs", fact: "The team indents with tabs", confidence: 0.8,
      sourceSessionIds: ["ses_other"], sourceMemoryIds: [], accessCount: 1, lastAccessedAt: "",
      strength: 0.8, createdAt: "", updatedAt: "",
    };
    await kv.set(KV.semantic, "sem_theirs", { ...theirs });
    await consolidate(keyed(`subject="indentation" relation="style" object="tabs"`, "The team indents with tabs"));
    await consolidate(keyed(`subject="indentation" relation="style" object="spaces"`, "The team indents with spaces"));

    expect(await kv.get(KV.semantic, "sem_theirs")).toEqual(theirs);
    expect((await facts()).filter((f) => f.project === "proj")).toHaveLength(2);
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
