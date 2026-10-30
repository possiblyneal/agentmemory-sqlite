import { describe, it, expect } from "vitest";
import { recallSemanticFacts } from "../src/functions/semantic-recall.js";
import { KV } from "../src/state/schema.js";
import type { SemanticMemory } from "../src/types.js";

function countingKV() {
  const store = new Map<string, Map<string, unknown>>();
  const scope = (s: string) => {
    if (!store.has(s)) store.set(s, new Map());
    return store.get(s)!;
  };
  const sessionGets: string[] = [];
  return {
    sessionGets,
    get: async <T>(s: string, k: string) => {
      if (s === KV.sessions) sessionGets.push(k);
      return (scope(s).get(k) as T) ?? null;
    },
    set: async <T>(s: string, k: string, v: T) => (scope(s).set(k, v), v),
    delete: async (s: string, k: string) => void scope(s).delete(k),
    list: async <T>(s: string) => Array.from(scope(s).values()) as T[],
  };
}

function fact(i: number, sourceSessionIds: string[]): SemanticMemory {
  const at = new Date().toISOString();
  return {
    id: `sem_${i}`,
    fact: `fact number ${i}`,
    confidence: 0.8,
    sourceSessionIds,
    sourceMemoryIds: [],
    accessCount: 0,
    lastAccessedAt: at,
    strength: 1,
    createdAt: at,
    updatedAt: at,
  } as SemanticMemory;
}

describe("recallSemanticFacts project scoping", () => {
  it("reads each cited Session once however many facts cite it", async () => {
    const kv = countingKV();
    await kv.set(KV.sessions, "ses_a", { id: "ses_a", project: "proj" });
    await kv.set(KV.sessions, "ses_b", { id: "ses_b", project: "other" });
    for (let i = 0; i < 200; i++) {
      await kv.set(KV.semantic, `sem_${i}`, fact(i, ["ses_a", "ses_b", "ses_gone"]));
    }

    const recalled = await recallSemanticFacts(kv as never, 5, { project: "proj" });

    expect(recalled).toHaveLength(5);
    expect(kv.sessionGets.sort()).toEqual(["ses_a", "ses_b", "ses_gone"]);
  });
});
