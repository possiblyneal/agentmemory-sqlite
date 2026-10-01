import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { attribute, needleFor } from "../eval/runner/adapters/agentmemory.js";
import { grepAdapter } from "../eval/runner/adapters/grep.js";
import { randomAdapter } from "../eval/runner/adapters/random.js";
import { aggregate, compareToBaseline, scoreQuestion } from "../eval/runner/score.js";
import type { Question, QueryResult, Session } from "../eval/runner/types.js";

function question(overrides: Partial<Question>): Question {
  return { id: "q", type: "t", goldSessionIds: [], haystack: [], ...overrides };
}

function ranked(...ids: string[]): QueryResult {
  return { ranked: ids.map((sessionId, i) => ({ sessionId, score: ids.length - i })) };
}

describe("scoreQuestion", () => {
  it("charges a near-miss to precision even when the gold item is returned", () => {
    const row = scoreQuestion(question({ goldSessionIds: ["a"] }), ranked("a", "b"), 5, "x", 0);
    expect(row.recall).toBe(1);
    expect(row.precision).toBe(0.5);
    expect(row.hit).toBe(true);
    expect(row.topGoldRank).toBe(1);
  });

  it("scores a no-answer question as a hit only when nothing is returned", () => {
    const q = question({ goldSessionIds: [] });
    const empty = scoreQuestion(q, ranked(), 5, "x", 0);
    expect(empty).toMatchObject({ hit: true, precision: 1, recall: null, answerable: false });
    const noisy = scoreQuestion(q, ranked("a"), 5, "x", 0);
    expect(noisy).toMatchObject({ hit: false, precision: 0 });
  });

  it("truncates search results to k but scores an Injection as a whole", () => {
    const result = ranked("b", "c", "a");
    const search = scoreQuestion(question({ goldSessionIds: ["a"] }), result, 2, "x", 0);
    expect(search.recall).toBe(0);
    const injection = scoreQuestion(
      question({ path: "pre-tool-use", goldSessionIds: ["a"] }),
      result,
      2,
      "x",
      0,
    );
    expect(injection.recall).toBe(1);
    expect(injection.returned).toBe(3);
  });
});

describe("aggregate", () => {
  it("keeps each path's numbers apart and reports the no-answer clean rate", () => {
    const rows = [
      scoreQuestion(question({ id: "1", goldSessionIds: ["a"] }), ranked("a"), 5, "x", 1),
      scoreQuestion(question({ id: "2", goldSessionIds: [] }), ranked("a"), 5, "x", 1),
      scoreQuestion(
        question({ id: "3", path: "pre-tool-use", goldSessionIds: [] }),
        { ranked: [], chars: 0 },
        5,
        "x",
        1,
      ),
    ];
    const summary = aggregate(rows);
    expect(summary.x.search).toMatchObject({ n: 2, answerable: 1, recall: 1, noAnswerClean: 0 });
    expect(summary.x["pre-tool-use"]).toMatchObject({ n: 1, noAnswerClean: 1, meanChars: 0 });
  });
});

describe("compareToBaseline", () => {
  const stats = (recall: number, precision: number, noAnswerClean: number | null) => ({
    n: 1,
    answerable: 1,
    recall,
    precision,
    noAnswerClean,
    hit: 1,
    meanChars: null,
    latencyP50: 0,
  });
  const baseline = {
    tolerance: 0.05,
    metrics: { x: { search: { recall: 0.9, precision: 0.5, noAnswerClean: 0.5 } } },
  };

  it("passes a metric that dropped by no more than the tolerance", () => {
    const { failed } = compareToBaseline({ x: { search: stats(0.86, 0.6, 0.5) } }, baseline);
    expect(failed).toBe(false);
  });

  it("fails and names the metric that dropped below baseline minus tolerance", () => {
    const { failed, lines } = compareToBaseline({ x: { search: stats(0.8, 0.5, 0.5) } }, baseline);
    expect(failed).toBe(true);
    expect(lines.find((l) => l.includes("recall"))).toMatch(/FAIL.*0\.900.*0\.800.*-0\.100/);
  });

  it("fails when a baselined adapter path produced no numbers", () => {
    const { failed, lines } = compareToBaseline({}, baseline);
    expect(failed).toBe(true);
    expect(lines.join("\n")).toMatch(/x\/search.*missing/);
  });
});

describe("attribute", () => {
  const needles = [
    { text: needleFor("fixed the <retry> loop & backoff"), sessionId: "s1" },
    { text: needleFor("added helm chart support"), sessionId: "s2" },
  ];

  it("finds Observations through XML escaping and orders by first appearance", () => {
    const context =
      "<ctx>- added helm chart\n  support\n- fixed the &lt;retry&gt; loop &amp; backoff</ctx>";
    expect(attribute(context, needles).map((r) => r.sessionId)).toEqual(["s2", "s1"]);
  });

  it("attributes nothing in an Empty Injection", () => {
    expect(attribute("", needles)).toEqual([]);
  });
});

describe("random control", () => {
  it("returns the same k sessions for the same question", async () => {
    const sessions: Session[] = ["a", "b", "c", "d"].map((id) => ({ id }));
    const state = await randomAdapter.init(sessions);
    const q = question({ id: "q-1" });
    const first = await randomAdapter.query(q, state, 2);
    const second = await randomAdapter.query(q, state, 2);
    expect(first.ranked).toHaveLength(2);
    expect(second).toEqual(first);
  });
});

describe("coding-agent-life-v2 dataset", () => {
  const dir = new URL("../eval/data/coding-agent-life-v2/", import.meta.url);
  const sessions = JSON.parse(readFileSync(new URL("sessions.json", dir), "utf8")) as Session[];
  const queries = JSON.parse(readFileSync(new URL("queries.json", dir), "utf8")) as Question[];
  const ids = new Set(sessions.map((s) => s.id));

  it("points every gold id at a session in the same project", () => {
    for (const q of queries) {
      for (const gold of q.goldSessionIds) {
        expect(ids.has(gold), `${q.id} -> ${gold}`).toBe(true);
        expect(sessions.find((s) => s.id === gold)?.project, `${q.id} -> ${gold}`).toBe(q.project);
      }
    }
  });

  it("gives every Observation a needle no other Session shares", () => {
    const owner = new Map<string, string>();
    for (const s of sessions) {
      for (const o of s.observations ?? []) {
        const needle = needleFor(o.output);
        const prev = owner.get(needle);
        expect(prev === undefined || prev === s.id, `${s.id} shares "${needle}" with ${prev}`).toBe(
          true,
        );
        owner.set(needle, s.id);
      }
    }
  });

  it("lets the grep baseline find most answerable search questions", async () => {
    const state = await grepAdapter.init(sessions);
    const answerable = queries.filter((q) => (q.path ?? "search") === "search" && q.goldSessionIds.length > 0);
    let hits = 0;
    for (const q of answerable) {
      const { ranked } = await grepAdapter.query(q, state, 5);
      if (ranked.some((r) => q.goldSessionIds.includes(r.sessionId))) hits += 1;
    }
    expect(hits / answerable.length).toBeGreaterThan(0.5);
  });

  it("has no-answer questions on every path", () => {
    for (const path of ["search", "pre-tool-use", "session-start"]) {
      expect(queries.some((q) => (q.path ?? "search") === path && q.goldSessionIds.length === 0)).toBe(
        true,
      );
    }
  });
});
