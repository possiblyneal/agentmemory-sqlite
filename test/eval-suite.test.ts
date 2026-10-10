import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scoreCase, summarizePmb, type Belief, type PmbCase } from "../eval/runner/pmb-score.js";
import { HOLDOUT_ENV, openSplit, selectSplit } from "../eval/runner/split.js";
import { pairedBootstrap, type Ratio } from "../eval/runner/suite-stats.js";

const items = Array.from({ length: 50 }, (_, i) => ({ id: `q${i}`, group: i < 10 ? "small" : "large" }));
const split = (s: "dev" | "holdout") => selectSplit("bench", items, s, (x) => x.id, (x) => x.group);

describe("eval split", () => {
  afterEach(() => {
    delete process.env[HOLDOUT_ENV];
  });

  it("partitions every group into disjoint dev and holdout shares", () => {
    const dev = split("dev");
    const holdout = split("holdout");
    expect(new Set([...dev, ...holdout].map((x) => x.id)).size).toBe(50);
    expect(dev.filter((x) => holdout.includes(x))).toEqual([]);
    expect(holdout.filter((x) => x.group === "small")).toHaveLength(4);
    expect(holdout.filter((x) => x.group === "large")).toHaveLength(16);
  });

  it("is stable across calls and returns everything with no split", () => {
    expect(split("holdout")).toEqual(split("holdout"));
    expect(selectSplit("bench", items, undefined, (x) => x.id, (x) => x.group)).toEqual(items);
  });

  it("defaults to dev and logs every look that includes the holdout", () => {
    mkdirSync("tmp", { recursive: true });
    const dir = mkdtempSync("tmp/eval-suite-test-");
    const ledger = join(dir, "ledger.ndjson");
    try {
      expect(openSplit(undefined, "bench", ledger)).toBe("dev");
      expect(() => openSplit("holdout", "bench", ledger)).toThrow(/sealed/);
      expect(() => openSplit("all", "bench", ledger)).toThrow(/sealed/);
      process.env[HOLDOUT_ENV] = "abc-fast-holdout";
      expect(openSplit("holdout", "bench", ledger)).toBe("holdout");
      expect(openSplit("all", "bench", ledger)).toBe("all");
      const looks = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(looks).toMatchObject([
        { bench: "bench", split: "holdout", label: "abc-fast-holdout" },
        { bench: "bench", split: "all", label: "abc-fast-holdout" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("paired bootstrap", () => {
  const scores = (values: number[]): Record<string, Ratio> =>
    Object.fromEntries(values.map((v, i) => [`q${i}`, { num: v, den: 1 }]));

  it("calls an unchanged run a tie", () => {
    const base = scores([1, 0, 1, 1, 0, 1, 0, 0, 1, 1]);
    expect(pairedBootstrap(base, base).verdict).toBe("≈");
  });

  it("calls a consistent gain better, and worse when lower is better", () => {
    const base = scores(Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.5 : 0.4)));
    const cand = scores(Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.7 : 0.6)));
    expect(pairedBootstrap(base, cand)).toMatchObject({ verdict: "better", n: 40 });
    expect(pairedBootstrap(base, cand, true).verdict).toBe("worse");
  });

  it("widens the interval as alpha shrinks", () => {
    const base = scores(Array.from({ length: 40 }, (_, i) => (i % 3 ? 1 : 0)));
    const cand = scores(Array.from({ length: 40 }, (_, i) => (i % 4 ? 1 : 0)));
    const wide = pairedBootstrap(base, cand, false, 0.005);
    const narrow = pairedBootstrap(base, cand);
    expect(wide.low!).toBeLessThanOrEqual(narrow.low!);
    expect(wide.high!).toBeGreaterThanOrEqual(narrow.high!);
  });

  it("pools ratios by their denominators", () => {
    const base = { a: { num: 1, den: 10 }, b: { num: 1, den: 1 } };
    expect(pairedBootstrap(base, base).base).toBeCloseTo(2 / 11);
  });
});

describe("PrecisionMemBench scoring", () => {
  const dir = "eval/data/precisionmembench";
  const beliefs = JSON.parse(readFileSync(`${dir}/beliefs.seed.json`, "utf8")) as Belief[];
  const cases = JSON.parse(readFileSync(`${dir}/retrieval.cases.json`, "utf8")) as PmbCase[];

  it("passes all 77 cases for a perfect provider, as upstream does", () => {
    const rows = cases.map((c) => {
      const rb = c.expect.relevantBeliefs ?? {};
      const perfect = [...new Set([...(rb.shouldOnlyInclude ?? []), ...(rb.mustInclude ?? []), ...(rb.shouldInclude ?? [])])];
      return scoreCase(c, beliefs, perfect, 0);
    });
    expect(rows.filter((r) => !r.pass).map((r) => [r.caseId, r.failures])).toEqual([]);
    expect(summarizePmb(rows)).toMatchObject({ n: 77, pass: 77, active: 43, activePass: 43 });
  });

  it("passes only the structural and empty cases for a provider that returns nothing", () => {
    const summary = summarizePmb(cases.map((c) => scoreCase(c, beliefs, [], 0)));
    expect(summary.activePass).toBe(0);
    expect(summary.pass).toBe(34);
  });
});
