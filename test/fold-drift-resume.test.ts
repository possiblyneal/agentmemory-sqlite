import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { measureFoldDrift, screenOnePass } from "../eval/runner/fold-drift-core.js";
import { stopState } from "../eval/runner/fold-drift-stop.js";
import { runCheckpointed, type RunHeader } from "../eval/runner/fold-drift-resume.js";
import { FOLD_SYSTEM } from "../src/prompts/summary.js";
import type { CompressedObservation, MemoryProvider } from "../src/types.js";

const obs = (sessionId: string, n: number): CompressedObservation[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${sessionId}-o${i}`,
    sessionId,
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

function countingProvider(): MemoryProvider & { calls: number } {
  const p = {
    calls: 0,
    name: "fake",
    compress: async () => "",
    summarize: async (system: string) => {
      p.calls++;
      return system === FOLD_SYSTEM ? xml(["Use SQLite for storage"]) : xml(["Use SQLite for storage", "Keep hooks fire and forget"]);
    },
  };
  return p;
}

const IDS = ["s1", "s2", "s3", "s4"];
const header = (over: Partial<RunHeader> = {}): RunHeader => ({ store: "a.sqlite", batch: 3, mode: "full", sessions: IDS, ...over });
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "fold-drift-resume-")), "run.ndjson");

const runFull = (provider: MemoryProvider, file: string, resume: boolean, h = header(), stopAfter = Infinity) => {
  let started = 0;
  return runCheckpointed({
    file,
    header: h,
    resume,
    run: async (id) => {
      if (started++ >= stopAfter) throw new Error("killed");
      return measureFoldDrift(provider, obs(id, 6), { sessionId: id, project: "p", batch: 3 });
    },
  });
};

describe("runCheckpointed", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("resumes past finished Sessions and ends equal to an uninterrupted run", async () => {
    const whole = countingProvider();
    const uninterrupted = await runFull(whole, tmpFile(), false);

    const file = tmpFile();
    const first = countingProvider();
    await runFull(first, file, false, header(), 2);
    const callsForTwo = first.calls;

    const second = countingProvider();
    const resumed = await runFull(second, file, true);

    expect(second.calls).toBe(whole.calls - callsForTwo);
    expect(resumed.results).toEqual(uninterrupted.results);
    expect(resumed.failed).toEqual([]);
  });

  it("reruns a Session cut off midway from its start", async () => {
    const file = tmpFile();
    await runFull(countingProvider(), file, false, header({ sessions: ["s1", "s2"] }));
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.slice(0, text.length - 40));

    const provider = countingProvider();
    const resumed = await runFull(provider, file, true, header({ sessions: ["s1", "s2"] }));
    expect(resumed.results.map((r) => r.sessionId)).toEqual(["s1", "s2"]);
    expect(provider.calls).toBeGreaterThan(0);
  });

  it("refuses a resume whose store, batch, mode or Sessions differ, naming each", async () => {
    const file = tmpFile();
    await runFull(countingProvider(), file, false);
    const provider = countingProvider();
    await expect(runFull(provider, file, true, header({ store: "b.sqlite" }))).rejects.toThrow(/store: .*a\.sqlite.*b\.sqlite/);
    await expect(runFull(provider, file, true, header({ batch: 9 }))).rejects.toThrow(/batch: .*3.*9/);
    await expect(runFull(provider, file, true, header({ mode: "screen" }))).rejects.toThrow(/mode: .*full.*screen/);
    await expect(runFull(provider, file, true, header({ sessions: ["s1", "s9"] }))).rejects.toThrow(/sessions:.*s2.*s9/s);
    expect(provider.calls).toBe(0);
  });

  it("resumes screening runs the same way", async () => {
    const h = header({ mode: "screen" });
    const run = (provider: MemoryProvider, file: string, resume: boolean, stopAfter: number) => {
      let started = 0;
      return runCheckpointed({
        file,
        header: h,
        resume,
        run: async (id) => {
          if (started++ >= stopAfter) throw new Error("killed");
          return screenOnePass(provider, obs(id, 6), { sessionId: id, project: "p", batch: 3 }, { judge: async () => false, key: [] });
        },
      });
    };
    const file = tmpFile();
    const first = countingProvider();
    await run(first, file, false, 1);
    const second = countingProvider();
    const resumed = await run(second, file, true, Infinity);
    const whole = countingProvider();
    const uninterrupted = await run(whole, tmpFile(), false, Infinity);
    expect(second.calls).toBe(whole.calls - first.calls);
    expect(resumed.results).toEqual(uninterrupted.results);
  });

  describe("with a stop decision", () => {
    const ordered = [
      { sessionId: "s1", keyDecisions: 8, neverCaptured: 8 },
      { sessionId: "s2", keyDecisions: 6, neverCaptured: 6 },
      { sessionId: "s3", keyDecisions: 1, neverCaptured: 1 },
    ];
    const armCounts: Record<string, number> = { s1: 0, s2: 0, s3: 1 };
    const stopHeader = header({ sessions: ["s1", "s2", "s3"], stop: { baseline: "base.json", threshold: 10 } });
    const attempt = (file: string, resume: boolean, killAfter = Infinity, h = stopHeader) => {
      const ran: string[] = [];
      return {
        ran,
        outcome: runCheckpointed({
          file,
          header: h,
          resume,
          run: async (id) => {
            if (ran.length >= killAfter) throw new Error("killed");
            ran.push(id);
            return { sessionId: id, count: armCounts[id]! };
          },
          stopAfter: (results) => {
            const state = stopState(ordered, new Map(results.map((r) => [r.sessionId, r.count])), 10);
            return state.stop ? state : null;
          },
        }),
      };
    };

    it("ends the run at the Session that decides it", async () => {
      const { ran, outcome } = attempt(tmpFile(), false);
      const { stopped, results } = await outcome;
      expect(ran).toEqual(["s1", "s2"]);
      expect(results.map((r) => r.sessionId)).toEqual(["s1", "s2"]);
      expect(stopped).toMatchObject({ stop: "cleared", gain: 14, skipped: ["s3"] });
    });

    it("reaches the same stop after a kill and after a resume past the deciding Session", async () => {
      const file = tmpFile();
      const killed = attempt(file, false, 1);
      expect((await killed.outcome).failed).toHaveLength(2);
      const resumed = attempt(file, true);
      const { stopped } = await resumed.outcome;
      expect(resumed.ran).toEqual(["s2"]);
      expect(stopped).toMatchObject({ stop: "cleared", skipped: ["s3"] });

      const again = attempt(file, true);
      expect((await again.outcome).stopped).toMatchObject({ stop: "cleared", skipped: ["s3"] });
      expect(again.ran).toEqual([]);
    });

    it("refuses a resume with another baseline, threshold or Session order", async () => {
      const file = tmpFile();
      await attempt(file, false).outcome;
      await expect(attempt(file, true, Infinity, { ...stopHeader, stop: { baseline: "base.json", threshold: 5 } }).outcome).rejects.toThrow(/stop:/);
      await expect(attempt(file, true, Infinity, { ...stopHeader, stop: undefined }).outcome).rejects.toThrow(/stop:/);
      await expect(attempt(file, true, Infinity, { ...stopHeader, sessions: ["s2", "s1", "s3"] }).outcome).rejects.toThrow(/different order/);
    });
  });
});
