import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { measureFoldDrift, rescoreFoldDrift, type StoredFoldDrift } from "../eval/runner/fold-drift-core.js";
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

const storedSession = (sessionId: string, full: string[], folded: string[]) => ({
  sessionId,
  fullSummary: { keyDecisions: full },
  foldedSummary: { keyDecisions: folded },
});

const stored = (): StoredFoldDrift => ({
  store: "ckpt.sqlite",
  batch: 20,
  sessions: [
    storedSession("s1", [ALL[0]!, ALL[1]!], [ALL[1]!]),
    storedSession("s2", [ALL[2]!], [ALL[2]!]),
    storedSession("s3", [], []),
  ],
  llm: { model: "m", baseUrl: "http://broker/v1" },
});

const keyedBy = (...rows: Array<[string, string, string]>): Decision[] =>
  rows.map(([id, sessionId, text]) => ({ id, sessionId, project: "p", source: "typed", text }));

describe("rescoreFoldDrift", () => {
  const key = keyedBy(
    ["a", "s1", ALL[0]!],
    ["b", "s1", ALL[1]!],
    ["c", "s1", "Nobody wrote this"],
    ["d", "s2", ALL[2]!],
    ["e", "s3", "Lost in s3"],
    ["f", "other", ALL[0]!],
  );

  it("counts, per Session and in total, key decisions in the one pass, in the fold, and in neither", async () => {
    const r = await rescoreFoldDrift(stored(), { sessionIds: ["s1", "s2", "s3"], batch: 20 }, { judge: includesJudge(), key });
    expect(r.sessions.map(({ sessionId, inOnePass, inFolded, neverCaptured }) => ({ sessionId, inOnePass, inFolded, neverCaptured }))).toEqual([
      { sessionId: "s1", inOnePass: 2, inFolded: 1, neverCaptured: 1 },
      { sessionId: "s2", inOnePass: 1, inFolded: 1, neverCaptured: 0 },
      { sessionId: "s3", inOnePass: 0, inFolded: 0, neverCaptured: 1 },
    ]);
    expect(r.total).toEqual({ keyDecisions: 5, inOnePass: 3, inFolded: 2, neverCaptured: 2 });
  });

  it("scores only the requested Sessions when they are a subset of the stored ones", async () => {
    const r = await rescoreFoldDrift(stored(), { sessionIds: ["s2"], batch: 20 }, { judge: includesJudge(), key });
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["s2"]);
    expect(r.total.keyDecisions).toBe(1);
  });

  it("refuses a Session the stored run does not hold, naming it", async () => {
    await expect(
      rescoreFoldDrift(stored(), { sessionIds: ["s1", "s9"], batch: 20 }, { judge: includesJudge(), key }),
    ).rejects.toThrow(/s9/);
  });

  it("refuses a batch that differs from the stored one, naming both", async () => {
    await expect(
      rescoreFoldDrift(stored(), { sessionIds: ["s1"], batch: 50 }, { judge: includesJudge(), key }),
    ).rejects.toThrow(/batch.*20.*50/);
  });

  it("refuses a different store, naming both", async () => {
    await expect(
      rescoreFoldDrift(stored(), { sessionIds: ["s1"], batch: 20, store: "other.sqlite" }, { judge: includesJudge(), key }),
    ).rejects.toThrow(/ckpt\.sqlite.*other\.sqlite/);
  });

  it("refuses a different model when the stored run recorded one", async () => {
    await expect(
      rescoreFoldDrift(stored(), { sessionIds: ["s1"], batch: 20, llm: { model: "m2", baseUrl: "http://broker/v1" } }, { judge: includesJudge(), key }),
    ).rejects.toThrow(/model.*m.*m2/);
  });

  it("accepts a stored run that recorded no model", async () => {
    const { llm: _llm, ...old } = stored();
    const r = await rescoreFoldDrift(old, { sessionIds: ["s1"], batch: 20, llm: { model: "m2", baseUrl: "x" } }, { judge: includesJudge(), key });
    expect(r.sessions).toHaveLength(1);
  });
});
