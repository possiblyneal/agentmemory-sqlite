import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { measureFoldDrift } from "../eval/runner/fold-drift-core.js";
import { FOLD_SYSTEM } from "../src/prompts/summary.js";
import type { CompressedObservation, MemoryProvider } from "../src/types.js";
import type { Judge } from "../eval/runner/decision-judge.js";
import type { Decision } from "../eval/runner/decision-key.js";

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

// A whole-Session summary of the first batch alone finds only the first decision.
function fakeProvider(foldReply: string[]): MemoryProvider {
  return {
    name: "fake",
    compress: async () => "",
    summarize: async (system: string, prompt: string) =>
      system === FOLD_SYSTEM ? xml(foldReply) : xml(prompt.includes("(3 total)") ? [ALL[0]!] : ALL),
  };
}

const opts = { sessionId: "s1", project: "p", batch: 3 };

describe("measureFoldDrift", () => {
  it("counts a decision the fold sequence never found", async () => {
    const r = await measureFoldDrift(fakeProvider([ALL[0]!, ALL[1]!]), obs(6), opts);
    expect(r.full).toBe(3);
    expect(r.folded).toBe(2);
    expect(r.folds).toBe(1);
    expect(r.fallbacks).toBe(0);
    expect(r.missingExact).toBe(1);
    expect(r.missingLoose).toBe(1);
  });

  it("counts a prior decision the fold's rewrite dropped", async () => {
    const r = await measureFoldDrift(fakeProvider([ALL[1]!]), obs(6), opts);
    expect(r.folds).toBe(1);
    expect(r.folded).toBe(1);
    expect(r.droppedExact).toBe(1);
    expect(r.droppedLoose).toBe(1);
  });

  it("counts an unparseable fold reply as a fallback, not a fold", async () => {
    const provider: MemoryProvider = {
      name: "fake",
      compress: async () => "",
      summarize: async (system: string) => (system === FOLD_SYSTEM ? "not xml" : xml(ALL)),
    };
    const r = await measureFoldDrift(provider, obs(6), opts);
    expect(r.folds).toBe(0);
    expect(r.fallbacks).toBe(1);
  });

  it("counts what a fallback's re-summarize drops apart from fold drops", async () => {
    const provider: MemoryProvider = {
      name: "fake",
      compress: async () => "",
      summarize: async (system: string, prompt: string) =>
        system === FOLD_SYSTEM ? "not xml" : xml(prompt.includes("(3 total)") ? [ALL[0]!] : [ALL[1]!]),
    };
    const r = await measureFoldDrift(provider, obs(6), opts);
    expect(r.fallbacks).toBe(1);
    expect(r.droppedExact).toBe(0);
    expect(r.fallbackDroppedExact).toBe(1);
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
    expect(r.droppedExact).toBe(0);
    expect(r.droppedLoose).toBe(0);
  });
});

const includesJudge = (paraphrases: Record<string, string> = {}): Judge => ({
  delivers: async (decision, injected) =>
    injected.toLowerCase().includes((paraphrases[decision.text] ?? decision.text).toLowerCase()),
});

const keyed = (...texts: string[]): Decision[] =>
  texts.map((text, i) => ({ id: `d${i}`, sessionId: "s1", project: "p", source: "typed", text }));

describe("measureFoldDrift judged by the decision judge", () => {
  it("keeps lexical counts and counts a paraphrased decision as delivered", async () => {
    const r = await measureFoldDrift(
      fakeProvider(["SQLite is the storage layer", ALL[1]!]),
      obs(6),
      opts,
      { judge: includesJudge({ [ALL[0]!]: "sqlite is the storage layer" }), key: [] },
    );
    expect(r.missingExact).toBe(2);
    expect(r.missingLoose).toBe(2);
    expect(r.missingJudged).toBe(1);
    expect(r.missing).toEqual([ALL[0], ALL[2]]);
  });

  it("leaves the judged count unset without a judge", async () => {
    const r = await measureFoldDrift(fakeProvider(ALL), obs(6), opts);
    expect(r.missingJudged).toBeUndefined();
    expect(r.labels).toBeUndefined();
  });

  it("labels key decisions never-captured, kept and dropped-by-fold", async () => {
    const provider: MemoryProvider = {
      name: "fake",
      compress: async () => "",
      summarize: async (system: string, prompt: string) =>
        system === FOLD_SYSTEM ? xml([ALL[1]!]) : xml(prompt.includes("(3 total)") ? [ALL[0]!] : [ALL[0]!, ALL[1]!]),
    };
    const r = await measureFoldDrift(provider, obs(6), opts, {
      judge: includesJudge(),
      key: keyed(ALL[0]!, ALL[1]!, "Something nobody wrote"),
    });
    expect(r.labels).toEqual([
      { decisionId: "d0", label: "dropped-by-fold" },
      { decisionId: "d1", label: "kept" },
      { decisionId: "d2", label: "never-captured" },
    ]);
    expect(r.steps.map((s) => s.kind)).toEqual(["first", "fold"]);
    expect(r.steps[1]!.decisions).toEqual([ALL[1]]);
  });

  it("labels by the fold sequence a decision the one pass missed", async () => {
    const provider: MemoryProvider = {
      name: "fake",
      compress: async () => "",
      summarize: async (system: string, prompt: string) =>
        system === FOLD_SYSTEM ? xml([ALL[1]!]) : xml(prompt.includes("(3 total)") ? [ALL[1]!, ALL[2]!] : [ALL[0]!]),
    };
    const r = await measureFoldDrift(provider, obs(6), opts, { judge: includesJudge(), key: keyed(ALL[1]!, ALL[2]!) });
    expect(r.labels).toEqual([
      { decisionId: "d0", label: "kept" },
      { decisionId: "d1", label: "dropped-by-fold" },
    ]);
  });

  it("labels a decision lost in a fallback re-summarize dropped-by-fallback", async () => {
    let n = 0;
    const provider: MemoryProvider = {
      name: "fake",
      compress: async () => "",
      summarize: async (system: string) =>
        system === FOLD_SYSTEM ? "not xml" : xml([[ALL[0]!, ALL[1]!], [ALL[0]!], [ALL[1]!]][n++]!),
    };
    const r = await measureFoldDrift(provider, obs(6), opts, { judge: includesJudge(), key: keyed(ALL[0]!) });
    expect(r.steps.map((s) => s.kind)).toEqual(["first", "fallback"]);
    expect(r.labels).toEqual([{ decisionId: "d0", label: "dropped-by-fallback" }]);
  });

  it("ignores key decisions from other Sessions", async () => {
    const other = { ...keyed(ALL[0]!)[0]!, sessionId: "s2" };
    const r = await measureFoldDrift(fakeProvider(ALL), obs(6), opts, { judge: includesJudge(), key: [other] });
    expect(r.labels).toEqual([]);
  });
});
