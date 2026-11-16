import { describe, it, expect } from "vitest";
import { graphExtractionSettled, waitUntilSettled, consolidationFailed } from "../eval/runner/replay-derived.js";
import { sandboxEnv } from "../eval/runner/sandbox.js";
import { probeArgs } from "../eval/runner/arm-core.js";

const obs = (timestamp: string) => ({ timestamp, title: "t" });

describe("graphExtractionSettled", () => {
  it("is settled when the Session has no Observations to extract", () => {
    expect(graphExtractionSettled(undefined, [])).toBe(true);
  });

  it("waits while the watermark is absent or behind the last Observation", () => {
    const o = [obs("2026-01-01T00:00:01Z"), obs("2026-01-01T00:00:02Z")];
    expect(graphExtractionSettled(undefined, o)).toBe(false);
    expect(graphExtractionSettled("2026-01-01T00:00:01Z", o)).toBe(false);
  });

  it("is settled once the watermark reaches the last Observation", () => {
    const o = [obs("2026-01-01T00:00:02Z"), obs("2026-01-01T00:00:01Z")];
    expect(graphExtractionSettled("2026-01-01T00:00:02Z", o)).toBe(true);
  });
});

describe("waitUntilSettled", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("returns settled as soon as the read says so", async () => {
    const reads = [{ settled: false, progress: "a" }, { settled: true, progress: "b" }];
    const result = await waitUntilSettled(async () => reads.shift()!, { stallMs: 1000, pollMs: 100, ...clock() });
    expect(result).toBe("settled");
  });

  it("gives up once progress has not changed for stallMs", async () => {
    const result = await waitUntilSettled(async () => ({ settled: false, progress: "same" }), { stallMs: 1000, pollMs: 100, ...clock() });
    expect(result).toBe("stalled");
  });

  it("keeps waiting while progress keeps changing", async () => {
    let n = 0;
    const result = await waitUntilSettled(async () => ({ settled: ++n > 50, progress: String(n) }), { stallMs: 1000, pollMs: 100, ...clock() });
    expect(result).toBe("settled");
  });
});

describe("consolidationFailed", () => {
  it("counts an unsuccessful or skipped reply as failed", () => {
    expect(consolidationFailed({ success: true })).toBe(false);
    expect(consolidationFailed({ success: false, skipped: true })).toBe(true);
    expect(consolidationFailed({})).toBe(true);
  });
});

describe("derived sandbox env", () => {
  it("keeps the stop's own consolidation from ever being due and leaves graph extraction to the shell", () => {
    const before = process.env.GRAPH_EXTRACTION_ENABLED;
    delete process.env.GRAPH_EXTRACTION_ENABLED;
    const env = sandboxEnv("/h", "/s.sqlite", "/m", "none", true, false, true);
    if (before !== undefined) process.env.GRAPH_EXTRACTION_ENABLED = before;
    expect("GRAPH_EXTRACTION_ENABLED" in env).toBe(false);
    expect(Number(env.AGENTMEMORY_CONSOLIDATION_COOLDOWN_MS)).toBeGreaterThan(Date.now() * 100);
  });

  it("leaves the cooldown alone without the mode", () => {
    const env = sandboxEnv("/h", "/s.sqlite", "/m", "none", true, false);
    expect("AGENTMEMORY_CONSOLIDATION_COOLDOWN_MS" in env).toBe(false);
  });
});

describe("probeArgs", () => {
  it("drops --derived from the probe pass", () => {
    expect(probeArgs(["--projects=a", "--llm-summary", "--derived"])).toEqual(["--projects=a"]);
  });
});
