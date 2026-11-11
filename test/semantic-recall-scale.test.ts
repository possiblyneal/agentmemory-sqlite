import { describe, it, expect } from "vitest";
import { recallSemanticFacts } from "../src/functions/semantic-recall.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";
import type { SemanticMemory } from "../src/types.js";

function fact(id: string, text: string, confidence = 0.8, createdAt = new Date().toISOString()): SemanticMemory {
  return {
    id,
    fact: text,
    confidence,
    sourceSessionIds: ["ses_a"],
    sourceMemoryIds: [],
    accessCount: 0,
    lastAccessedAt: createdAt,
    strength: 1,
    createdAt,
    updatedAt: createdAt,
  } as SemanticMemory;
}

async function store(facts: SemanticMemory[]) {
  const kv = mockKV();
  await kv.set(KV.sessions, "ses_a", { id: "ses_a", project: "proj" });
  for (const f of facts) await kv.set(KV.semantic, f.id, f);
  return kv;
}

const texts = async (kv: ReturnType<typeof mockKV>, query: string) =>
  (await recallSemanticFacts(kv as never, 10, { query, project: "proj" })).map((r) => r.fact.fact);

describe("recallSemanticFacts at scale", () => {
  it("answers over 20,000 matching facts without comparing every pair", async () => {
    const day = 86_400_000;
    const facts = Array.from({ length: 20_000 }, (_, i) =>
      fact(
        `sem_${i}`,
        `The daemon setting number ${i} for worker ${i % 97} keeps queue ${i % 13} bounded`,
        0.5 + (i % 50) / 100,
        new Date(Date.now() - i * day).toISOString(),
      ),
    );
    const kv = await store(facts);

    const start = performance.now();
    const recalled = await recallSemanticFacts(kv as never, 10, { query: "daemon queue setting", project: "proj" });
    const noQuery = await recallSemanticFacts(kv as never, 5, { project: "proj" });
    const elapsed = performance.now() - start;

    expect(recalled).toHaveLength(10);
    expect(noQuery).toHaveLength(5);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("recallSemanticFacts term matching", () => {
  it("does not match a fact on a function word alone", async () => {
    const kv = await store([fact("sem_budget", "The token budget is 500"), fact("sem_other", "Other matters wait")]);
    expect(await texts(kv, "the budget")).toEqual(["The token budget is 500"]);
  });

  it("returns nothing for a query made only of function words", async () => {
    const kv = await store([fact("sem_budget", "The token budget is 500")]);
    expect(await texts(kv, "to the")).toEqual([]);
  });

  it("matches a term at the start of a word, not inside one", async () => {
    const kv = await store([fact("sem_indent", "The team indents with tabs")]);
    expect(await texts(kv, "indent")).toEqual(["The team indents with tabs"]);
    expect(await texts(kv, "dents")).toEqual([]);
  });

  it("ignores punctuation around a query term", async () => {
    const kv = await store([fact("sem_cfg", "tsconfig.json sets strict mode")]);
    expect(await texts(kv, "(tsconfig.json)?")).toEqual(["tsconfig.json sets strict mode"]);
  });

  it("matches a term with punctuation inside only where the whole term starts a word", async () => {
    const kv = await store([
      fact("sem_cfg", "tsconfig.json sets strict mode"),
      fact("sem_base", "tsconfig.base extends nothing"),
      fact("sem_inner", "the old.tsconfig.json was removed"),
    ]);
    expect(await texts(kv, "tsconfig.json")).toEqual([
      "tsconfig.json sets strict mode",
      "the old.tsconfig.json was removed",
    ]);
  });
});
