import { describe, it, expect } from "vitest";
import { parseArmArgs, probeArgs, resumePlan, failedSessionIndex } from "../eval/runner/arm-core.js";

const cp = (index: number) => ({ sessionId: `id${index}`, file: `${String(index).padStart(3, "0")}-id${index}.sqlite`, ingested: [] as string[] });

describe("parseArmArgs", () => {
  it("takes ref and label and forwards every other flag to the replay passes", () => {
    expect(parseArmArgs(["--ref", "main", "--label", "before", "--projects=a,b", "--cap", "40"])).toEqual({
      ref: "main",
      label: "before",
      replayArgs: ["--projects=a,b", "--cap", "40"],
    });
  });

  it("requires a ref and a label", () => {
    expect(() => parseArmArgs(["--label", "x"])).toThrow(/--ref/);
    expect(() => parseArmArgs(["--ref", "main"])).toThrow(/--label/);
  });

  it("rejects a label that is not a plain directory name", () => {
    expect(() => parseArmArgs(["--ref", "main", "--label", "../x"])).toThrow(/label/);
  });

  it("rejects the replay flags the arm sets itself", () => {
    expect(() => parseArmArgs(["--ref", "main", "--label", "x", "--out", "tmp/y"])).toThrow(/--out/);
    expect(() => parseArmArgs(["--ref", "main", "--label", "x", "--save-checkpoints"])).toThrow(/--save-checkpoints/);
  });
});

describe("probeArgs", () => {
  it("drops the flags that make a pass compress or summarize, keeping the rest", () => {
    expect(probeArgs(["--projects=a", "--llm-summary", "--cap", "40", "--llm"])).toEqual(["--projects=a", "--cap", "40"]);
  });
});

describe("failedSessionIndex", () => {
  it("reads the zero-based Session index from a progress line with failed summarizes", () => {
    expect(failedSessionIndex("[12/41] 0a1b2c3d checkpoint probe=0s import=90s stops=4 summarized=1 failed=2 total=900s")).toBe(11);
  });

  it("ignores a line with no failures or another shape", () => {
    expect(failedSessionIndex("[12/41] 0a1b2c3d unscored stops=4 summarized=1 failed=0 total=9s")).toBeUndefined();
    expect(failedSessionIndex("import failed: boom")).toBeUndefined();
  });
});

describe("resumePlan", () => {
  it("keeps checkpoints at or before the failed Session and names the later files to remove", () => {
    const manifest = [cp(0), cp(3), cp(9), cp(12)];
    const plan = resumePlan(manifest, 9);
    expect(plan.keep.map((c) => c.file)).toEqual([cp(0).file, cp(3).file, cp(9).file]);
    expect(plan.remove).toEqual([cp(12).file]);
  });

  it("keeps nothing when the failure precedes the first checkpoint's Session", () => {
    expect(resumePlan([cp(5)], 2)).toEqual({ keep: [], remove: [cp(5).file] });
  });
});
