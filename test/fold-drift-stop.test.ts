import { describe, it, expect } from "vitest";
import { baselineSessions, orderByBaseline, stopState, verdictOf, type BaselineSession } from "../eval/runner/fold-drift-stop.js";

const base = (sessionId: string, neverCaptured: number, keyDecisions = neverCaptured): BaselineSession => ({ sessionId, keyDecisions, neverCaptured });

// Walks the order as the CLI does, finishing one Session at a time.
function run(ordered: BaselineSession[], arm: Record<string, number>, threshold: number) {
  const done = new Map<string, number>();
  for (const s of ordered) {
    done.set(s.sessionId, arm[s.sessionId]!);
    const state = stopState(ordered, done, threshold);
    if (state.stop) return { state, ran: done.size };
  }
  return { state: stopState(ordered, done, threshold), ran: done.size };
}

describe("baselineSessions and orderByBaseline", () => {
  const rescored = [
    { sessionId: "a", keyDecisions: 10, inOnePass: 6, inFolded: 7, neverCaptured: 2 },
    { sessionId: "b", keyDecisions: 10, inOnePass: 2, inFolded: 8, neverCaptured: 1 },
  ];
  it("uses in-neither for a full run and not-in-one-pass for a screen", () => {
    expect(baselineSessions(rescored, "full").map((s) => s.neverCaptured)).toEqual([2, 1]);
    expect(baselineSessions(rescored, "screen").map((s) => s.neverCaptured)).toEqual([4, 8]);
  });
  it("orders most never-captured first and keeps given order on ties", () => {
    const ordered = orderByBaseline([base("x", 1), base("y", 5), base("z", 1), base("w", 5)]);
    expect(ordered.map((s) => s.sessionId)).toEqual(["y", "w", "x", "z"]);
  });
});

describe("stopState", () => {
  it("stops cleared once even the worst unfinished Sessions cannot undo the gain", () => {
    const ordered = [base("a", 8, 8), base("b", 6, 6), base("c", 1, 1)];
    const { state, ran } = run(ordered, { a: 0, b: 0, c: 1 }, 10);
    expect(ran).toBe(2);
    expect(state).toMatchObject({ stop: "cleared", gain: 14, skipped: ["c"] });
  });

  it("does not stop on a gain a later Session could lose", () => {
    const ordered = [base("a", 12, 20), base("b", 0, 20)];
    const { state, ran } = run(ordered, { a: 0, b: 20 }, 10);
    expect(ran).toBe(2);
    expect(state.stop).toBeNull();
    expect(verdictOf(state.gain, 10)).toBe("not cleared");
  });

  it("stops unreachable once the remaining baseline counts cannot close the gap", () => {
    const ordered = [base("a", 9), base("b", 3), base("c", 2)];
    const { state, ran } = run(ordered, { a: 9, b: 3, c: 2 }, 10);
    expect(ran).toBe(1);
    expect(state).toMatchObject({ stop: "unreachable", gain: 0, skipped: ["b", "c"] });
  });

  it("is undecided to the end when the gain lands on or short of the threshold only at the last Session", () => {
    const ordered = [base("a", 5), base("b", 5), base("c", 5)];
    const { state, ran } = run(ordered, { a: 2, b: 2, c: 2 }, 10);
    expect(ran).toBe(3);
    expect(state.stop).toBeNull();
    expect(state.gain).toBe(9);
    expect(verdictOf(state.gain, 10)).toBe("not cleared");
  });

  it("clears at exactly the threshold and gives a tie below it to the baseline", () => {
    expect(verdictOf(10, 10)).toBe("cleared");
    expect(verdictOf(9, 10)).toBe("not cleared");
  });

  it("agrees with a full run's verdict for every arm outcome over a small fixed corpus", () => {
    const ordered = [base("a", 4, 6), base("b", 3, 5), base("c", 2, 4), base("d", 0, 3)];
    const limits = ordered.map((s) => s.keyDecisions);
    for (let a = 0; a <= limits[0]!; a++)
      for (let b = 0; b <= limits[1]!; b++)
        for (let c = 0; c <= limits[2]!; c++)
          for (let d = 0; d <= limits[3]!; d++)
            for (const threshold of [1, 3, 5]) {
              const arm = { a, b, c, d };
              const early = run(ordered, arm, threshold).state;
              const fullGain = 4 - a + (3 - b) + (2 - c) + (0 - d);
              const verdict = verdictOf(early.gain, threshold);
              if (early.stop === "cleared") expect(verdictOf(fullGain, threshold)).toBe("cleared");
              else if (early.stop === "unreachable") expect(verdictOf(fullGain, threshold)).toBe("not cleared");
              else expect(verdict).toBe(verdictOf(fullGain, threshold));
            }
  });
});
