import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { measureFoldDrift } from "../eval/runner/fold-drift-core.js";
import { FOLD_SYSTEM } from "../src/prompts/summary.js";
import type { CompressedObservation, MemoryProvider } from "../src/types.js";

const obs = (n: number): CompressedObservation[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `o${i}`,
    sessionId: "s1",
    timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    type: "file_edit",
    title: `edit ${i}`,
    facts: [],
    narrative: `changed thing ${i}`,
    concepts: [],
    files: [],
    importance: 5,
  }));

const xml = (decisions: string[]) =>
  `<summary><title>T</title><narrative>A narrative long enough to validate.</narrative><decisions>${decisions
    .map((d) => `<decision>${d}</decision>`)
    .join("")}</decisions><files></files><concepts></concepts></summary>`;

const ALL = ["Use SQLite for storage", "Keep hooks fire and forget", "Cap summaries at ten decisions"];

function fakeProvider(foldReply: string[]): MemoryProvider {
  return {
    name: "fake",
    compress: async () => "",
    summarize: async (system: string) =>
      system === FOLD_SYSTEM ? xml(foldReply) : xml(ALL),
  };
}

const opts = { sessionId: "s1", project: "p", batch: 3 };

describe("measureFoldDrift", () => {
  it("counts a decision the fold sequence dropped", async () => {
    const r = await measureFoldDrift(fakeProvider([ALL[0]!, ALL[1]!]), obs(6), opts);
    expect(r.full).toBe(3);
    expect(r.folded).toBe(2);
    expect(r.folds).toBe(1);
    expect(r.missingExact).toBe(1);
    expect(r.missingLoose).toBe(1);
  });

  it("matches normalized text and counts a reworded decision as loosely matched", async () => {
    const r = await measureFoldDrift(
      fakeProvider(["use sqlite for storage.", "Keep hooks fire and forget always", ALL[2]!]),
      obs(6),
      opts,
    );
    expect(r.missingExact).toBe(1);
    expect(r.missingLoose).toBe(0);
  });

  it("reports no drift when the fold keeps everything", async () => {
    const r = await measureFoldDrift(fakeProvider(ALL), obs(6), opts);
    expect(r.missingExact).toBe(0);
    expect(r.missingLoose).toBe(0);
  });
});
