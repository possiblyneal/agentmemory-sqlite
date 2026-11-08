import { describe, it, expect } from "vitest";
import { cumulativeLine, mcnemarExact, pairDecisions, refuseFailedSummaries, type DecisionRow } from "../eval/runner/compare-core.js";

const row = (sessionId: string, decisions: DecisionRow["decisions"]): DecisionRow => ({ sessionId, decisions });
const d = (decisionId: string, turn: number, sessionStart: boolean, promptSubmit: boolean, reachable?: boolean) => ({
  decisionId,
  turn,
  sessionStart,
  promptSubmit,
  ...(reachable === undefined ? {} : { reachable }),
});

describe("mcnemarExact", () => {
  it("is 1 when the runs disagree equally often", () => {
    expect(mcnemarExact(4, 4)).toBe(1);
  });

  it("is 1 with no discordant items", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  it("doubles the lower binomial tail (0 vs 10 gives 2/1024)", () => {
    expect(mcnemarExact(0, 10)).toBeCloseTo(2 / 1024, 12);
    expect(mcnemarExact(10, 0)).toBeCloseTo(2 / 1024, 12);
  });

  it("matches a worked tail sum for 29 vs 6 (2 * P(X <= 6 | n = 35) = 1.1684e-4)", () => {
    expect(mcnemarExact(29, 6)).toBeCloseTo(1.168419e-4, 9);
  });
});

describe("pairDecisions", () => {
  it("counts an item delivered by either surface and pairs on session, turn and decision", () => {
    const a = [row("s1", [d("x", 1, true, false), d("y", 2, false, false), d("z", 3, false, true)])];
    const b = [row("s1", [d("x", 1, false, false), d("y", 2, false, true), d("z", 3, true, false)])];
    expect(pairDecisions(a, b)).toEqual({ both: 1, aOnly: 1, bOnly: 1, neither: 0, aDelivered: 2, bDelivered: 2 });
  });

  it("keeps only items reachable in both runs, treating a missing flag as reachable", () => {
    const a = [row("s1", [d("x", 1, true, false, false), d("y", 2, true, false), d("w", 4, false, false)])];
    const b = [row("s1", [d("x", 1, true, false, true), d("y", 2, false, false, true), d("w", 4, false, false)])];
    expect(pairDecisions(a, b)).toEqual({ both: 0, aOnly: 1, bOnly: 0, neither: 1, aDelivered: 1, bDelivered: 0 });
  });

  it("ignores an item only one run scored", () => {
    const a = [row("s1", [d("x", 1, true, false)])];
    const b = [row("s2", [d("x", 1, true, false)])];
    expect(pairDecisions(a, b)).toEqual({ both: 0, aOnly: 0, bOnly: 0, neither: 0, aDelivered: 0, bDelivered: 0 });
  });

  it("keeps the same decision asked at two turns as two items", () => {
    const a = [row("s1", [d("x", 1, true, false), d("x", 5, true, false)])];
    const b = [row("s1", [d("x", 1, true, false), d("x", 5, false, false)])];
    expect(pairDecisions(a, b).aOnly).toBe(1);
    expect(pairDecisions(a, b).both).toBe(1);
  });
});

describe("cumulativeLine", () => {
  const byTurn = (decisionId: string, turn: number, promptSubmit: boolean, promptSubmitByTurn: boolean) => ({
    ...d(decisionId, turn, false, promptSubmit),
    promptSubmitByTurn,
  });

  it("pairs prompt-submit credited by turn, leaving the same-turn pairing to McNemar", () => {
    const a = [row("s1", [byTurn("x", 2, false, true), byTurn("y", 3, false, false), byTurn("z", 4, true, true)])];
    const b = [row("s1", [byTurn("x", 2, false, false), byTurn("y", 3, false, true), byTurn("z", 4, false, true)])];
    expect(pairDecisions(a, b)).toMatchObject({ both: 0, aOnly: 1, bOnly: 0, neither: 2 });
    expect(cumulativeLine({ label: "A", rows: a }, { label: "B", rows: b })).toBe(
      "  delivered by turn: A 2   B 2   both 1   A-only 1   B-only 1   neither 0",
    );
  });

  it("names a run probed before the by-turn flag existed", () => {
    const old = [row("s1", [d("x", 2, false, true)])];
    const fresh = [row("s1", [byTurn("x", 2, true, true)])];
    expect(cumulativeLine({ label: "old", rows: old }, { label: "new", rows: fresh })).toBe(
      "  delivered by turn: not recorded by old; rerun its probe",
    );
  });
});

describe("refuseFailedSummaries", () => {
  it("names a run whose save pass had failed summarize calls", () => {
    expect(refuseFailedSummaries([{ label: "A", failedSummarizeCalls: 2 }, { label: "B", failedSummarizeCalls: 0 }])).toMatch(/A.*2/);
  });

  it("accepts runs with none, or with no count recorded", () => {
    expect(refuseFailedSummaries([{ label: "A", failedSummarizeCalls: 0 }, { label: "B", failedSummarizeCalls: undefined }])).toBeUndefined();
  });
});
