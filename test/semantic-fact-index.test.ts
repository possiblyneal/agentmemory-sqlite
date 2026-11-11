import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteState, stateFunctions } from "../src/engine/inproc/state.js";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { recallSemanticFacts } from "../src/functions/semantic-recall.js";
import { registerConsolidationPipelineFunction } from "../src/functions/consolidation-pipeline.js";
import type { SemanticMemory, SessionSummary } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

type Handler = (payload: any) => Promise<unknown>;

// A StateKV over a real SqliteState, so every write path reaches the store's
// write generation exactly as it does in the daemon.
function realStore(dir: string) {
  const state = new SqliteState(join(dir, "state.sqlite"));
  const functions = new Map<string, Handler>(Object.entries(stateFunctions(state)));
  const calls: string[] = [];
  const sdk = {
    registerFunction: (id: string | { id: string }, handler: Handler) =>
      void functions.set(typeof id === "string" ? id : id.id, handler),
    registerTrigger: () => {},
    trigger: async (req: { function_id: string; payload: unknown }) => {
      calls.push(req.function_id);
      return functions.get(req.function_id)!(req.payload);
    },
  };
  return { state, sdk, calls, kv: new StateKV(sdk as never) };
}

function fact(id: string, text: string, overrides: Partial<SemanticMemory> = {}): SemanticMemory {
  const at = "2026-11-01T00:00:00.000Z";
  return {
    id,
    fact: text,
    confidence: 0.8,
    sourceSessionIds: ["ses_a"],
    sourceMemoryIds: [],
    accessCount: 1,
    lastAccessedAt: at,
    strength: 0.8,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe("Semantic Fact recall index", () => {
  let dir: string;
  let store: ReturnType<typeof realStore>;
  const recalled = async (query = "indents") =>
    (await recallSemanticFacts(store.kv, 10, { query, project: "proj" })).map((r) => r.fact.fact).sort();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "am-semantic-index-"));
    store = realStore(dir);
    await store.kv.set(KV.sessions, "ses_a", { id: "ses_a", project: "proj" });
    await store.kv.set(KV.semantic, "sem_tabs", fact("sem_tabs", "The team indents with tabs"));
    expect(await recalled()).toEqual(["The team indents with tabs"]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    store.state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads no fact rows on a repeat recall, only the ones it returns", async () => {
    store.calls.length = 0;
    expect(await recalled()).toEqual(["The team indents with tabs"]);
    expect(store.calls).not.toContain("state::list-page");
    expect(store.calls).not.toContain("state::list");
  });

  it("sees a fact written after the index was built (consolidation, import, restore)", async () => {
    await store.kv.set(KV.semantic, "sem_width", fact("sem_width", "The team indents four columns"));
    expect(await recalled()).toEqual(["The team indents four columns", "The team indents with tabs"]);
  });

  it("drops a fact closed by supersession", async () => {
    await store.kv.set(KV.semantic, "sem_tabs", fact("sem_tabs", "The team indents with tabs", { isLatest: false }));
    expect(await recalled()).toEqual([]);
  });

  it("drops a fact deleted one at a time (forget, governance, retention)", async () => {
    await store.kv.delete(KV.semantic, "sem_tabs");
    expect(await recalled()).toEqual([]);
  });

  it("drops a fact deleted in bulk (auto-forget)", async () => {
    await store.kv.deleteManyIfUnchanged(KV.semantic, [{ key: "sem_tabs", updatedAt: "2026-11-01T00:00:00.000Z" }]);
    expect(await recalled()).toEqual([]);
  });

  it("drops a fact removed by an unconditional bulk delete", async () => {
    await store.kv.deleteMany(KV.semantic, ["sem_tabs"]);
    expect(await recalled()).toEqual([]);
  });

  it("sees text rewritten in bulk (decay, mesh sync)", async () => {
    await store.kv.setMany(KV.semantic, [{ key: "sem_tabs", value: fact("sem_tabs", "The team indents with spaces") }]);
    expect(await recalled("spaces")).toEqual(["The team indents with spaces"]);
    await store.kv.setManyIfUnchanged(KV.semantic, [
      { key: "sem_tabs", value: fact("sem_tabs", "The team indents with hard tabs"), updatedAt: "2026-11-01T00:00:00.000Z" },
    ]);
    expect(await recalled("hard")).toEqual(["The team indents with hard tabs"]);
  });

  it("sees a field update", async () => {
    await store.kv.update(KV.semantic, "sem_tabs", [{ type: "set", path: "isLatest", value: false }]);
    expect(await recalled()).toEqual([]);
  });

  it("sees a write made on the store directly (startup maintenance)", async () => {
    store.state.set(KV.semantic, "sem_tabs", fact("sem_tabs", "The team indents with spaces"));
    expect(await recalled("spaces")).toEqual(["The team indents with spaces"]);
  });

  it("is not invalidated by writes to other scopes", async () => {
    await store.kv.set(KV.sessions, "ses_b", { id: "ses_b", project: "proj" });
    store.calls.length = 0;
    await recalled();
    expect(store.calls).not.toContain("state::list-page");
  });

  it("follows consolidation closing a keyed fact", async () => {
    vi.stubEnv("CONSOLIDATION_ENABLED", "true");
    const summary: SessionSummary = {
      sessionId: "ses_a",
      project: "proj",
      createdAt: "2026-11-01T00:00:00.000Z",
      title: "Style",
      narrative: "Agreed indentation",
      keyDecisions: [],
      filesModified: [],
      concepts: ["style"],
      observationCount: 3,
    };
    for (let i = 0; i < 5; i++) {
      await store.kv.set(KV.summaries, `ses_${i}`, { ...summary, sessionId: `ses_${i}` });
      await store.kv.set(KV.sessions, `ses_${i}`, { id: `ses_${i}`, project: "proj" });
    }
    let reply = "";
    const provider = { name: "t", compress: vi.fn(), summarize: vi.fn(async () => reply) };
    registerConsolidationPipelineFunction(store.sdk as never, store.kv, provider as never);
    const consolidate = async (object: string, text: string) => {
      reply = `<facts><fact confidence="0.9" subject="indentation" relation="style" object="${object}">${text}</fact></facts>`;
      await store.sdk.trigger({ function_id: "mem::consolidate-pipeline", payload: { tier: "semantic", project: "proj" } });
    };

    await consolidate("tabs", "The team indents with tab characters");
    expect(await recalled()).toContain("The team indents with tab characters");
    await consolidate("spaces", "The team indents with spaces");
    const after = await recalled();
    expect(after).toContain("The team indents with spaces");
    expect(after).not.toContain("The team indents with tab characters");
  });
});
