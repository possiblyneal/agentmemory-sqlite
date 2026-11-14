import { describe, expect, it } from "vitest";
import { ShedQueue } from "../src/functions/shed-queue.js";
import { latency, percentile, summarizeRuns, type RunResult } from "../eval/runner/burst-core.js";

function deferred() {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  return { done, release };
}

describe("ShedQueue", () => {
  it("runs tasks one at a time in arrival order", async () => {
    const queue = new ShedQueue(1000, () => 0);
    const order: string[] = [];
    const first = deferred();
    const a = queue.run(async () => {
      order.push("a:start");
      await first.done;
      order.push("a:end");
      return "a";
    });
    const b = queue.run(async () => {
      order.push("b:start");
      return "b";
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);
    expect(queue.depth).toBe(1);
    first.release();
    expect(await a).toEqual({ shed: false, value: "a" });
    expect(await b).toEqual({ shed: false, value: "b" });
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("skips a task that waited past the limit and runs the next", async () => {
    let clock = 0;
    const queue = new ShedQueue(1500, () => clock);
    const first = deferred();
    const ran: string[] = [];
    const a = queue.run(async () => {
      ran.push("a");
      await first.done;
    });
    const b = queue.run(async () => void ran.push("b"));
    await Promise.resolve();
    await Promise.resolve();
    clock = 1600;
    const c = queue.run(async () => void ran.push("c"));
    first.release();
    await a;
    expect(await b).toEqual({ shed: true });
    expect(await c).toEqual({ shed: false, value: undefined });
    expect(ran).toEqual(["a", "c"]);
    expect(queue.shed).toBe(1);
  });

  it("passes a task's error to its caller and keeps serving", async () => {
    const queue = new ShedQueue(1000, () => 0);
    await expect(queue.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await queue.run(async () => 1)).toEqual({ shed: false, value: 1 });
  });
});

describe("burst statistics", () => {
  it("counts a timed-out call as late whatever its time", () => {
    const l = latency(
      [
        { ms: 100, timedOut: false },
        { ms: 1500, timedOut: false },
        { ms: 900, timedOut: true },
        { ms: 2000, timedOut: false },
      ],
      1500,
    );
    expect(l).toMatchObject({ n: 4, inTime: 2, max: 2000 });
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });

  it("summarizes runs by median", () => {
    const run = (inTime: number): RunResult => ({
      label: "x",
      run: 1,
      loadBefore: 0,
      sessions: 32,
      firstPrompt: { n: 32, inTime, p50: 1000, p95: 2000, max: 3000 },
      sessionStart: { n: 32, inTime: 32, p50: 1, p95: 1, max: 1 },
      laterPrompt: { n: 10, inTime: 10, p50: 1, p95: 300, max: 400 },
      livez: { n: 10, p95: 10, max: 20 },
    });
    expect(summarizeRuns("x", [run(2), run(20), run(16)])).toMatchObject({ firstInTimeMedian: 16, livezMax: 20 });
  });
});
