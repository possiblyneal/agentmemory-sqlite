import { describe, it, expect } from "vitest";
import { recallSemanticFacts } from "../src/functions/semantic-recall.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";
import type { SemanticMemory } from "../src/types.js";

function countingKV() {
  const kv = mockKV();
  const sessionGets: string[] = [];
  const get = kv.get;
  kv.get = async <T>(scope: string, key: string) => {
    if (scope === KV.sessions) sessionGets.push(key);
    return get<T>(scope, key);
  };
  return Object.assign(kv, { sessionGets });
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
