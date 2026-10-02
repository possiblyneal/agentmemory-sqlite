import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerContextFunction } from "../src/functions/context.js";
import { registerEnrichFunction } from "../src/functions/enrich.js";
import {
  registerInjectionsFunction,
  INJECTION_RETENTION_MS,
  injectedItemUse,
} from "../src/functions/injections.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import type { CompressedObservation, InjectionRecord, Lesson, Insight, Memory } from "../src/types.js";

const now = new Date().toISOString();

function lesson(id: string, project: string): Lesson {
  return {
    id, content: `lesson ${id}`, context: "", confidence: 0.8, reinforcements: 1,
    source: "manual", sourceIds: [], project, tags: [], createdAt: now, updatedAt: now,
    decayRate: 0.05,
  };
}

function insight(id: string, project: string): Insight {
  return {
    id, title: `insight ${id}`, content: "content", confidence: 0.7, project,
    createdAt: now, updatedAt: now,
  } as unknown as Insight;
}

function bugMemory(id: string, file: string): Memory {
  return {
    id, type: "bug", title: `bug ${id}`, content: "broke", concepts: [], files: [file],
    sessionIds: [], strength: 1, version: 1, isLatest: true, project: "/p",
    createdAt: now, updatedAt: now,
  } as unknown as Memory;
}

async function seedSession(kv: ReturnType<typeof mockKV>, id: string, withSummary: boolean) {
  await kv.set(KV.sessions, id, {
    id, project: "/p", cwd: "/p", startedAt: now, status: "completed", observationCount: 1,
  });
  if (withSummary) {
    await kv.set(KV.summaries, id, {
      sessionId: id, project: "/p", title: `summary ${id}`, narrative: "n",
      keyDecisions: [], filesModified: [], concepts: [], createdAt: now, observationCount: 1,
    });
  } else {
    await kv.set(KV.observations(id), "obs_1", {
      id: "obs_1", sessionId: id, timestamp: now, type: "file_edit", title: "edited",
      narrative: "did it", facts: [], concepts: [], files: ["src/a.ts"], importance: 6,
    });
  }
}

describe("mem::context reports what it injected", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    kv = mockKV();
    sdk = mockSdk();
    registerContextFunction(sdk as never, kv as never, 4000);
  });

  it("lists every lesson, insight, summary and observation it rendered", async () => {
    await kv.set(KV.lessons, "les_1", lesson("les_1", "/p"));
    await kv.set(KV.insights, "ins_1", insight("ins_1", "/p"));
    await seedSession(kv, "ses_sum", true);
    await seedSession(kv, "ses_obs", false);

    const result = await sdk.trigger("mem::context", { sessionId: "ses_now", project: "/p" });

    expect(result.injected).toEqual(
      expect.arrayContaining([
        { kind: "lesson", id: "les_1" },
        { kind: "insight", id: "ins_1" },
        { kind: "summary", id: "ses_sum" },
        { kind: "observation", id: "obs_1", files: ["src/a.ts"] },
      ]),
    );
    expect(result.injected).toHaveLength(4);
  });

  it("leaves out the sources of a block the budget dropped", async () => {
    await kv.set(KV.lessons, "les_1", lesson("les_1", "/p"));
    const result = await sdk.trigger("mem::context", { sessionId: "s", project: "/p", budget: 1 });
    expect(result.injected).toEqual([]);
  });
});

describe("mem::enrich reports what it injected", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    kv = mockKV();
    sdk = mockSdk();
    registerEnrichFunction(sdk as never, kv as never);
  });

  it("lists file-context observations, search observations and bug Memories", async () => {
    sdk.registerFunction("mem::file-context", async () => ({
      context: "<agentmemory-file-context>x</agentmemory-file-context>",
      injected: [{ kind: "observation", id: "obs_file" }],
    }));
    sdk.registerFunction("mem::search", async () => ({
      results: [{ observation: { id: "obs_search", narrative: "seen before" } }],
    }));
    await kv.set(KV.memories, "mem_bug", bugMemory("mem_bug", "src/a.ts"));

    const result = await sdk.trigger("mem::enrich", {
      sessionId: "s", files: ["src/a.ts"], project: "/p",
    });

    expect(result.injected).toEqual([
      { kind: "observation", id: "obs_file" },
      { kind: "observation", id: "obs_search" },
      { kind: "memory", id: "mem_bug", files: ["src/a.ts"] },
    ]);
  });

  it("drops the sources of every part that truncation cut into", async () => {
    sdk.registerFunction("mem::file-context", async () => ({
      context: "x".repeat(3900),
      injected: [{ kind: "observation", id: "obs_file" }],
    }));
    sdk.registerFunction("mem::search", async () => ({
      results: [{ observation: { id: "obs_search", narrative: "y".repeat(500) } }],
    }));

    const result = await sdk.trigger("mem::enrich", { sessionId: "s", files: ["src/a.ts"] });

    expect(result.truncated).toBe(true);
    expect(result.injected).toEqual([{ kind: "observation", id: "obs_file" }]);
  });
});

describe("Injection records", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    kv = mockKV();
    sdk = mockSdk();
    registerInjectionsFunction(sdk as never, kv as never);
  });

  it("lists one Session's records oldest first", async () => {
    const base = { source: "context", project: "/p", injected: [], tokens: 0 } as const;
    await kv.set(KV.injections, "b", { ...base, id: "b", sessionId: "s1", at: "2026-01-02T00:00:00Z" });
    await kv.set(KV.injections, "a", { ...base, id: "a", sessionId: "s1", at: "2026-01-01T00:00:00Z" });
    await kv.set(KV.injections, "c", { ...base, id: "c", sessionId: "s2", at: "2026-01-01T00:00:00Z" });

    const result = await sdk.trigger("mem::injections-list", { sessionId: "s1" });

    expect(result.injections.map((r: InjectionRecord) => r.id)).toEqual(["a", "b"]);
  });

  it("sweeps records older than the retention window and keeps the rest", async () => {
    const base = { source: "enrich", sessionId: "s", injected: [], tokens: 0 } as const;
    const old = new Date(Date.now() - INJECTION_RETENTION_MS - 60_000).toISOString();
    await kv.set(KV.injections, "old", { ...base, id: "old", at: old });
    await kv.set(KV.injections, "new", { ...base, id: "new", at: new Date().toISOString() });

    const result = await sdk.trigger("mem::injections-sweep", {});

    expect(result.swept).toBe(1);
    expect((await kv.list<InjectionRecord>(KV.injections)).map((r) => r.id)).toEqual(["new"]);
  });
});

describe("REST Injection paths write a record", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    kv = mockKV();
    sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never);
    registerInjectionsFunction(sdk as never, kv as never);
  });

  it("records the context path and keeps injected refs off the wire", async () => {
    sdk.registerFunction("mem::context", async () => ({
      context: "<ctx/>", blocks: 1, tokens: 12, injected: [{ kind: "lesson", id: "les_1" }],
    }));

    const res = await sdk.trigger("api::context", { body: { sessionId: "s1", project: "/p" } });
    await flush();

    expect(res.status_code).toBe(200);
    expect(res.body).not.toHaveProperty("injected");
    const [record] = await kv.list<InjectionRecord>(KV.injections);
    expect(record).toMatchObject({
      source: "context", sessionId: "s1", project: "/p", tokens: 12,
      injected: [{ kind: "lesson", id: "les_1" }],
    });
  });

  it("records an Empty Injection with no identifiers", async () => {
    sdk.registerFunction("mem::enrich", async () => ({ context: "", truncated: false, injected: [] }));

    await sdk.trigger("api::enrich", { body: { sessionId: "s1", files: ["a.ts"], project: "/p" } });
    await flush();

    const [record] = await kv.list<InjectionRecord>(KV.injections);
    expect(record).toMatchObject({ source: "enrich", sessionId: "s1", injected: [], tokens: 0 });
  });

  describe("session start", () => {
    beforeEach(() => {
      sdk.registerFunction("mem::context", async () => ({
        context: "<ctx/>", blocks: 1, tokens: 5, injected: [{ kind: "summary", id: "ses_0" }],
      }));
    });
    afterEach(() => vi.unstubAllEnvs());

    it("records session start when the hook injects context", async () => {
      vi.stubEnv("AGENTMEMORY_INJECT_CONTEXT", "true");

      await sdk.trigger("api::session::start", { body: { sessionId: "s1", project: "/p", cwd: "/p" } });
      await flush();

      const records = await kv.list<InjectionRecord>(KV.injections);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ source: "session-start", sessionId: "s1", tokens: 5 });
    });

    it("records nothing when injection is off, since the hook discards the reply", async () => {
      vi.stubEnv("AGENTMEMORY_INJECT_CONTEXT", "false");

      await sdk.trigger("api::session::start", { body: { sessionId: "s1", project: "/p", cwd: "/p" } });
      await flush();

      expect(await kv.list<InjectionRecord>(KV.injections)).toHaveLength(0);
    });
  });

  it("still answers the Injection when writing the record throws", async () => {
    sdk.registerFunction("mem::context", async () => ({
      context: "<ctx/>", blocks: 1, tokens: 5, injected: [],
    }));
    const set = kv.set;
    kv.set = (async (scope: string, key: string, data: unknown) => {
      if (scope === KV.injections) throw new Error("disk full");
      return set(scope, key, data);
    }) as typeof kv.set;

    const res = await sdk.trigger("api::context", { body: { sessionId: "s1", project: "/p" } });
    await flush();

    expect(res.status_code).toBe(200);
    expect(res.body.context).toBe("<ctx/>");
  });

  it("serves a Session's records over REST", async () => {
    await kv.set(KV.injections, "a", {
      id: "a", source: "context", sessionId: "s1", injected: [], tokens: 0, at: now,
    });

    const res = await sdk.trigger("api::injections", { query_params: { sessionId: "s1" } });
    const missing = await sdk.trigger("api::injections", { query_params: {} });

    expect(res.status_code).toBe(200);
    expect(res.body.injections).toHaveLength(1);
    expect(missing.status_code).toBe(400);
  });
});

describe("injectedItemUse", () => {
  const at = "2026-01-01T00:00:00.000Z";

  function obs(over: Partial<CompressedObservation>): CompressedObservation {
    return {
      id: "o", sessionId: "s1", timestamp: "2026-01-01T00:05:00.000Z", type: "file_edit",
      title: "Edit", narrative: "", facts: [], concepts: [], files: [], importance: 5, ...over,
    };
  }

  const record = (over: Partial<InjectionRecord> = {}): InjectionRecord => ({
    id: "r", source: "context", sessionId: "s1", injected: [], tokens: 0, at, ...over,
  });

  it("counts a later touch of one of the item's files", () => {
    const ref = { kind: "memory" as const, id: "mem_1", files: ["src/a.ts"] };
    expect(injectedItemUse(ref, record(), [obs({ files: ["./src/a.ts"] })])).toBe("used");
    expect(injectedItemUse(ref, record(), [obs({ files: ["/repo/src/a.ts"] })])).toBe("used");
  });

  it("counts an explicit recall that names the item", () => {
    const ref = { kind: "memory" as const, id: "mem_1", files: ["src/a.ts"] };
    const recall = obs({ title: "mcp__agentmemory__memory_get", narrative: '{"id":"mem_1"}' });
    expect(injectedItemUse(ref, record(), [recall])).toBe("used");
  });

  it("does not count an item nothing touched or named", () => {
    const ref = { kind: "memory" as const, id: "mem_1", files: ["src/a.ts"] };
    expect(injectedItemUse(ref, record(), [obs({ files: ["src/b.ts"] })])).toBe("unused");
  });

  it("does not score a Memory with no files", () => {
    const ref = { kind: "memory" as const, id: "mem_1" };
    expect(injectedItemUse(ref, record(), [obs({ narrative: "mem_1" })])).toBe("unscorable");
  });

  it("ignores Observations from before the Injection", () => {
    const ref = { kind: "memory" as const, id: "mem_1", files: ["src/a.ts"] };
    const earlier = obs({ timestamp: "2025-12-31T23:59:00.000Z", files: ["src/a.ts"] });
    expect(injectedItemUse(ref, record(), [earlier])).toBe("unused");
  });

  it("does not let the tool call that triggered an enrich Injection count as use", () => {
    const ref = { kind: "observation" as const, id: "obs_1", files: ["src/a.ts", "src/b.ts"] };
    const enrich = record({ source: "enrich", files: ["src/a.ts"] });
    expect(injectedItemUse(ref, enrich, [obs({ files: ["src/a.ts"] })])).toBe("unused");
    expect(injectedItemUse(ref, enrich, [obs({ files: ["src/b.ts"] })])).toBe("used");
  });

  it("does not score an item whose only files triggered the Injection", () => {
    const ref = { kind: "observation" as const, id: "obs_1", files: ["src/a.ts"] };
    const enrich = record({ source: "enrich", files: ["src/a.ts"] });
    expect(injectedItemUse(ref, enrich, [])).toBe("unscorable");
  });
});

describe("Injected refs carry their files", () => {
  it("records the files an enrich Injection was asked about", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::enrich", async () => ({ context: "x", injected: [] }));

    await sdk.trigger("api::enrich", { body: { sessionId: "s1", files: ["src/a.ts"] } });
    await new Promise((r) => setTimeout(r, 0));

    const [record] = await kv.list<InjectionRecord>(KV.injections);
    expect(record.files).toEqual(["src/a.ts"]);
  });

  it("mem::context attaches observation and summary files", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerContextFunction(sdk as never, kv as never, 4000);
    await seedSession(kv, "ses_obs", false);

    const result = await sdk.trigger("mem::context", { sessionId: "now", project: "/p" });

    expect(result.injected).toEqual([{ kind: "observation", id: "obs_1", files: ["src/a.ts"] }]);
  });
});
