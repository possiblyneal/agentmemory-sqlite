import { describe, expect, it } from "vitest";
import { keyedSessionIds, unreachableOrigins, unreachableWarning, type DecisionKey } from "../eval/runner/decision-key.js";
import { selectSessions } from "../eval/runner/replay-load.js";
import type { ReplaySession } from "../eval/runner/replay-transcript.js";

function session(id: string, project: string, startedAt: string, turns: number): ReplaySession {
  const userTurns = Array.from({ length: turns }, (_, i) => ({ turn: i + 1, text: `t${i}` }));
  return { id, project, cwd: `/w/${project}`, startedAt, userTurns: userTurns as ReplaySession["userTurns"], fileUses: [], compactedAfter: [] };
}

describe("selectSessions", () => {
  const sessions = [
    session("a1", "alpha", "2026-01-01", 5),
    session("a2", "alpha", "2026-01-02", 5),
    session("a3", "alpha", "2026-01-03", 5),
    session("a4", "alpha", "2026-01-04", 1),
    session("b1", "beta", "2026-01-02T12:00", 5),
  ];

  it("keeps the earliest cap Sessions per project, in time order", () => {
    const { sessions: picked, perProject } = selectSessions(sessions, { cap: 2, minTurns: 2 });
    expect(picked.map((s) => s.id)).toEqual(["a1", "a2", "b1"]);
    expect(perProject.alpha).toEqual({ replayable: 3, replayed: 2 });
  });

  it("adds an included Session the cap or min-turns would drop, in time order", () => {
    const { sessions: picked, perProject } = selectSessions(sessions, { cap: 2, minTurns: 2, include: new Set(["a3", "a4"]) });
    expect(picked.map((s) => s.id)).toEqual(["a1", "a2", "b1", "a3", "a4"]);
    expect(perProject.alpha).toEqual({ replayable: 4, replayed: 4 });
  });

  it("ignores an included id that no loaded Session has", () => {
    const { sessions: picked } = selectSessions(sessions, { cap: 2, minTurns: 2, include: new Set(["gone"]) });
    expect(picked.map((s) => s.id)).toEqual(["a1", "a2", "b1"]);
  });
});

describe("unreachable key origins", () => {
  const key: DecisionKey = {
    version: 1,
    builtAt: "2026-01-01T00:00:00Z",
    decisions: [
      { id: "d1", sessionId: "s-old", project: "p", source: "typed", text: "x" },
      { id: "d2", sessionId: "s-old", project: "p", source: "typed", text: "y" },
      { id: "d3", sessionId: "s-mid", project: "p", source: "ask", text: "z" },
    ],
    expected: [
      { sessionId: "s-new", turn: 1, decisionIds: ["d1", "d3"] },
      { sessionId: "s-new", turn: 2, decisionIds: ["d1", "d2"] },
    ],
  };

  it("names every Session the key's items touch", () => {
    expect([...keyedSessionIds(key)].sort()).toEqual(["s-mid", "s-new", "s-old"]);
  });

  it("counts the items whose origin Session is not replayed", () => {
    expect(unreachableOrigins(key, new Set(["s-new", "s-mid"]))).toEqual([{ sessionId: "s-old", items: 3 }]);
  });

  it("is empty when every origin is replayed", () => {
    const none = unreachableOrigins(key, new Set(["s-old", "s-mid", "s-new"]));
    expect(none).toEqual([]);
    expect(unreachableWarning(none)).toBeUndefined();
  });

  it("warns with the item count and the Session ids", () => {
    const warning = unreachableWarning(unreachableOrigins(key, new Set(["s-new"])));
    expect(warning).toContain("4 key items");
    expect(warning).toContain("s-old");
    expect(warning).toContain("s-mid");
  });
});
