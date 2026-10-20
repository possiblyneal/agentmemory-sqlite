import { describe, expect, it } from "vitest";
import { selectSplit } from "../eval/runner/split.js";
import { buildCases, PAIRS } from "../eval/runner/supersession-cases.js";
import { classify, summarize, type ScoreRow } from "../eval/runner/supersession-score.js";

describe("classify", () => {
  it("is stale-first when the stale claim leads", () => {
    expect(classify(["use tabs", "use spaces"], "use tabs", "use spaces")).toBe("stale-first");
  });

  it("is stale-first when only the stale claim came back", () => {
    expect(classify(["use tabs"], "use tabs", "use spaces")).toBe("stale-first");
  });

  it("is fresh-first when both came back and the newer leads", () => {
    expect(classify(["use spaces", "use tabs"], "use tabs", "use spaces")).toBe("fresh-first");
  });

  it("is stale-hidden when only the newer claim came back", () => {
    expect(classify(["use spaces"], "use tabs", "use spaces")).toBe("stale-hidden");
  });

  it("is neither when no claim came back", () => {
    expect(classify([], "use tabs", "use spaces")).toBe("neither");
  });

  it("reads order across items as well as within one string", () => {
    expect(classify(["x use spaces y", "z use tabs"], "use tabs", "use spaces")).toBe("fresh-first");
    expect(classify(["use tabs then use spaces"], "use tabs", "use spaces")).toBe("stale-first");
  });
});

describe("summarize", () => {
  const row = (caseId: string, variant: string, outcome: ScoreRow["outcome"]): ScoreRow => ({
    caseId,
    kind: "lesson",
    variant,
    surface: "search",
    outcome,
  });

  it("rates stale-first over the cases where a claim came back", () => {
    const [cell] = summarize([
      row("a", "v", "stale-first"),
      row("b", "v", "fresh-first"),
      row("c", "v", "stale-hidden"),
      row("d", "v", "neither"),
    ]);
    expect(cell).toMatchObject({ n: 4, staleFirst: 1, freshFirst: 1, staleHidden: 1, neither: 1 });
    expect(cell.staleFirstRate).toBeCloseTo(1 / 3);
  });

  it("has no rate when nothing came back", () => {
    expect(summarize([row("a", "v", "neither")])[0].staleFirstRate).toBeNull();
  });

  it("adds a rollup per kind and surface across variants", () => {
    const cells = summarize([row("a", "x", "stale-first"), row("b", "y", "fresh-first")]);
    expect(cells.map((c) => [c.variant, c.n, c.staleFirstRate])).toEqual([
      ["x", 1, 1],
      ["y", 1, 0],
      [null, 2, 0.5],
    ]);
  });
});

describe("supersession cases", () => {
  const cases = buildCases(new Date("2026-10-20T12:00:00.000Z"));

  it("gives every cell one case per pair, with unique ids and projects", () => {
    const groups = new Map<string, number>();
    for (const c of cases) groups.set(c.group, (groups.get(c.group) ?? 0) + 1);
    expect([...groups.values()].every((n) => n === PAIRS.length)).toBe(true);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.project)).size).toBe(cases.length);
  });

  it("covers the cells docs/supersession.md names as reachable", () => {
    const cells = new Set(cases.map((c) => `${c.kind}/${c.surface}`));
    expect([...cells].sort()).toEqual(
      [
        "memory/search",
        "memory/prompt-submit",
        "semantic-fact/search",
        "semantic-fact/session-start",
        "lesson/search",
        "lesson/session-start",
        "insight/search",
        "insight/session-start",
        "summary-decision/session-start",
        "summary-decision/prompt-submit",
        "observation/search",
        "observation/session-start",
        "observation/prompt-submit",
      ].sort(),
    );
  });

  it("keeps the stale claim out of the newer one's text, so a marker names one claim", () => {
    for (const c of cases) {
      expect(c.fresh.includes(c.stale), c.id).toBe(false);
      expect(c.stale.includes(c.fresh), c.id).toBe(false);
    }
  });

  it("keeps Memory text inside the 80-character title a search result carries", () => {
    for (const c of cases.filter((x) => x.kind === "memory")) {
      expect(c.stale.length, c.id).toBeLessThanOrEqual(80);
      expect(c.fresh.length, c.id).toBeLessThanOrEqual(80);
    }
  });

  it("puts both sides of the split in every cell, and the dev split is the smaller-sealed share", () => {
    const dev = selectSplit("supersession", cases, "dev", (c) => c.id, (c) => c.group);
    const holdout = selectSplit("supersession", cases, "holdout", (c) => c.id, (c) => c.group);
    expect(dev.length + holdout.length).toBe(cases.length);
    const groups = new Set(cases.map((c) => c.group));
    expect(new Set(dev.map((c) => c.group))).toEqual(groups);
    expect(new Set(holdout.map((c) => c.group))).toEqual(groups);
  });
});
