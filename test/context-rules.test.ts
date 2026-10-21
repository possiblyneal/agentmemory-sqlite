import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import type { Lesson, Memory, Session, SessionSummary } from "../src/types.js";
import { estimateTokens } from "../src/utils/tokens.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const PRE_COMPACT_BUDGET = 1500;

type Ctx = { context: string; injected: Array<{ kind: string; id: string }> };

describe("mem::context pins rule-typed Memories", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    kv = mockKV();
    sdk = mockSdk();
    registerContextFunction(sdk as never, kv as never, 4000);
  });

  const memory = (over: Partial<Memory> & { id: string }): Memory => ({
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    type: "rule",
    title: over.id,
    content: `content of ${over.id}`,
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 5,
    version: 1,
    isLatest: true,
    project: "/p",
    ...over,
  });

  const save = (m: Memory) => kv.set(KV.memories, m.id, m);

  async function bulkSummaries(n: number) {
    for (let i = 0; i < n; i++) {
      const s: Session = {
        id: `ses_${i}`,
        project: "/p",
        cwd: "/p",
        startedAt: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`,
        status: "completed",
        observationCount: 1,
      };
      await kv.set(KV.sessions, s.id, s);
      await kv.set(KV.summaries, s.id, {
        sessionId: s.id,
        project: "/p",
        createdAt: s.startedAt,
        title: `summary ${i}`,
        narrative: "n".repeat(900),
        keyDecisions: [],
        filesModified: [],
        concepts: [],
        observationCount: 1,
      } satisfies SessionSummary);
    }
  }

  const start = (budget?: number) =>
    sdk.trigger("mem::context", { sessionId: "ses_now", project: "/p", budget }) as Promise<Ctx>;

  it("keeps an early rule at a pre-compact budget ahead of newer blocks", async () => {
    await save(memory({ id: "mem_rule", content: "never push to main without asking" }));
    await bulkSummaries(8);
    const { context, injected } = await start(PRE_COMPACT_BUDGET);
    expect(context).toContain("never push to main without asking");
    expect(context.indexOf("never push to main")).toBeLessThan(context.indexOf("summary"));
    expect(injected).toContainEqual({ kind: "memory", id: "mem_rule" });
  });

  it("does not add a Memory that is not a rule", async () => {
    await save(memory({ id: "mem_fact", type: "fact", content: "the sky is blue" }));
    const { context } = await start();
    expect(context).not.toContain("the sky is blue");
  });

  it("does not show another project's rule, a superseded rule, or a rule of no project", async () => {
    await save(memory({ id: "o", project: "/other", content: "other project rule" }));
    await save(memory({ id: "s", isLatest: false, content: "superseded rule" }));
    await save(memory({ id: "n", project: undefined, content: "unscoped rule" }));
    const { context } = await start();
    expect(context).not.toContain("other project rule");
    expect(context).not.toContain("superseded rule");
    expect(context).not.toContain("unscoped rule");
  });

  it("orders rules newest first, and a pinned lesson appears once", async () => {
    await save(memory({ id: "old", updatedAt: "2026-02-01T00:00:00.000Z", content: "older rule" }));
    await save(memory({ id: "new", updatedAt: "2026-03-01T00:00:00.000Z", content: "newer rule" }));
    const lesson: Lesson = {
      id: "les_1",
      content: "pinned lesson text",
      context: "",
      confidence: 0.7,
      reinforcements: 1,
      source: "manual",
      sourceIds: [],
      project: "/p",
      tags: [],
      createdAt: "2026-01-15T00:00:00.000Z",
      updatedAt: "2026-01-15T00:00:00.000Z",
    };
    await kv.set(KV.lessons, lesson.id, lesson);
    const { context } = await start();
    expect(context.indexOf("newer rule")).toBeLessThan(context.indexOf("older rule"));
    expect(context.indexOf("older rule")).toBeLessThan(context.indexOf("pinned lesson text"));
    expect(context.split("pinned lesson text")).toHaveLength(2);
  });

  it("skips a rule too long for the pinned share and pins the older ones", async () => {
    await save(memory({ id: "long", updatedAt: "2026-03-01T00:00:00.000Z", content: `long rule ${"w".repeat(4000)}` }));
    await save(memory({ id: "short", updatedAt: "2026-02-01T00:00:00.000Z", content: "short older rule" }));
    const { context } = await start(PRE_COMPACT_BUDGET);
    expect(context).toContain("short older rule");
  });

  it("caps the pinned share of the budget at 40%", async () => {
    for (let i = 0; i < 30; i++) {
      const day = String(i + 1).padStart(2, "0");
      await save(
        memory({
          id: `r${i}`,
          updatedAt: `2026-02-${day}T00:00:00.000Z`,
          content: `rule ${i} ${"w".repeat(200)}`,
        }),
      );
    }
    const { context, injected } = await start(PRE_COMPACT_BUDGET);
    const from = context.indexOf("## Rules");
    const end = context.indexOf("\n\n", from);
    const block = context.slice(from, end === -1 ? undefined : end);
    expect(estimateTokens(block)).toBeLessThanOrEqual(PRE_COMPACT_BUDGET * 0.4);
    expect(injected.filter((r) => r.kind === "memory").length).toBeGreaterThan(0);
    expect(context).toContain("rule 29 ");
  });
});
