import { describe, it, expect } from "vitest";
import { newerAboveShadowed, shadowedMemoryIds } from "../src/functions/memory-shadow.js";
import { KV } from "../src/state/schema.js";
import type { Memory } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

function memory(id: string, content: string, createdAt: string, extra: Partial<Memory> = {}): Memory {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    type: "preference",
    title: content,
    content,
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 7,
    version: 1,
    supersedes: [],
    sourceObservationIds: [],
    isLatest: true,
    ...extra,
  };
}

async function shadowed(...memories: Memory[]) {
  const kv = mockKV();
  for (const m of memories) await kv.set(KV.memories, m.id, m);
  return shadowedMemoryIds(kv as never, memories.map((m) => m.id));
}

const OLD = "2026-10-01T00:00:00.000Z";
const NEW = "2026-10-02T00:00:00.000Z";
const TABS = "Formatting convention for the repository: tabs are used for indentation";
const SPACES = "Decision: two-space indentation is now mandatory throughout, tabs banned";

describe("shadowedMemoryIds", () => {
  it("names the newer Memory that shadows an older one sharing its subject", async () => {
    expect(await shadowed(memory("mem_a", TABS, OLD), memory("mem_b", SPACES, NEW))).toEqual(new Map([["mem_a", "mem_b"]]));
  });

  it("leaves Memories alone that share a single term", async () => {
    const other = "Release notes list tabs of changes grouped by area";
    expect((await shadowed(memory("mem_a", TABS, OLD), memory("mem_b", other, NEW))).size).toBe(0);
  });

  it("leaves a Memory alone when the newer one has another type or scope", async () => {
    expect((await shadowed(memory("mem_a", TABS, OLD), memory("mem_b", SPACES, NEW, { type: "fact" }))).size).toBe(0);
    expect((await shadowed(memory("mem_a", TABS, OLD), memory("mem_b", SPACES, NEW, { global: true }))).size).toBe(0);
  });

  it("never shadows the newer by the older", async () => {
    expect([...(await shadowed(memory("mem_a", TABS, NEW), memory("mem_b", SPACES, OLD))).keys()]).toEqual(["mem_b"]);
  });
});

describe("newerAboveShadowed", () => {
  const order = (items: string[], shadowed: [string, string][]) =>
    newerAboveShadowed(items, (i) => i, new Map(shadowed));

  it("moves the newer directly above the older and keeps both", () => {
    expect(order(["x", "old", "y", "new"], [["old", "new"]])).toEqual(["x", "new", "old", "y"]);
  });

  it("leaves the order alone when the newer is already above", () => {
    expect(order(["new", "x", "old"], [["old", "new"]])).toEqual(["new", "x", "old"]);
  });

  it("never adds a Memory that was not in the list", () => {
    expect(order(["old", "x"], [["old", "new"]])).toEqual(["old", "x"]);
  });
});
