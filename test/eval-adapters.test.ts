import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertVariedImportance,
  attribute,
  needleFor,
  rulebookShare,
} from "../eval/runner/adapters/agentmemory.js";
import { grepAdapter } from "../eval/runner/adapters/grep.js";
import { randomAdapter } from "../eval/runner/adapters/random.js";
import { aggregate, compareToBaseline, scoreQuestion, summarize } from "../eval/runner/score.js";
import { questionPath, type Question, type QueryResult, type Session } from "../eval/runner/types.js";

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
      question({ path: "prompt-submit", goldSessionIds: ["a"] }),
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
        question({ id: "3", path: "prompt-submit", goldSessionIds: [] }),
        { ranked: [], chars: 0 },
        5,
        "x",
        1,
      ),
    ];
    const { byPath } = aggregate(rows);
    expect(byPath.x.search).toMatchObject({ n: 2, answerable: 1, recall: 1, noAnswerClean: 0 });
    expect(byPath.x["prompt-submit"]).toMatchObject({ n: 1, noAnswerClean: 1, meanChars: 0 });
  });

  it("breaks the numbers down by question type per adapter", () => {
    const rows = [
      scoreQuestion(question({ id: "1", type: "decision", goldSessionIds: ["a"] }), ranked("a"), 5, "x", 1),
      scoreQuestion(question({ id: "2", type: "decision", goldSessionIds: ["b"] }), ranked("a"), 5, "x", 1),
      scoreQuestion(question({ id: "3", type: "file", goldSessionIds: ["a"] }), ranked("a"), 5, "x", 1),
    ];
    const { byType } = aggregate(rows);
    expect(byType.decision.x).toMatchObject({ n: 2, recall: 0.5, hit: 1 });
    expect(byType.file.x).toMatchObject({ n: 1, recall: 1 });
  });

  it("reports pinned-rule questions apart, with how often the rule leads and its largest share", () => {
    const rows = [
      scoreQuestion(
        question({ id: "1", type: "rule-buried", path: "pre-compact", goldSessionIds: ["r"] }),
        { ...ranked("r", "a"), rulebookShare: 0.05 },
        5,
        "x",
        1,
      ),
      scoreQuestion(
        question({ id: "2", type: "rule-amended", path: "pre-compact", goldSessionIds: ["r2"] }),
        { ...ranked("r1", "r2"), rulebookShare: 0.08 },
        5,
        "x",
        1,
      ),
      scoreQuestion(
        question({ id: "3", type: "project-coverage", path: "pre-compact", goldSessionIds: ["a"] }),
        ranked("b"),
        5,
        "x",
        1,
      ),
    ];
    const { byPath, rules } = aggregate(rows);
    expect(rules.x["pre-compact"]).toMatchObject({ n: 2, recall: 1, goldFirst: 0.5, rulebookShareMax: 0.08 });
    expect(byPath.x["pre-compact"].n).toBe(3);
  });
});

describe("rulebookShare", () => {
  it("measures the Rules block alone against the budget", () => {
    const rules = "## Rules\nStanding rules.\n- never run migrations from the deploy hook";
    const context = `## Pinned\n- slot\n\n${rules}\n\n## Session\n- ${"x".repeat(900)}`;
    expect(rulebookShare(context, 1000)).toBeCloseTo(Math.ceil(rules.length / 3) / 1000);
  });

  it("is undefined when no rule is pinned", () => {
    expect(rulebookShare("## Session\n- work", 1500)).toBeUndefined();
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
    goldFirst: null,
    meanChars: null,
    rulebookShareMax: null,
    latencyP50: 0,
    latencyP95: 0,
  });
  const baseline = {
    tolerance: 0.05,
    metrics: { x: { search: { recall: 0.9, precision: 0.5, noAnswerClean: 0.5 } } },
    latencyCeilingMs: {},
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

  describe("latency ceiling", () => {
    const withP95 = (latencyP95: number) => ({ ...stats(1, 1, 1), latencyP95 });
    const gated = { ...baseline, latencyCeilingMs: { x: { "prompt-submit": 500 } } };
    const run = (p95: number) => ({
      x: { search: stats(0.9, 0.5, 0.5), "prompt-submit": withP95(p95) },
    });

    it("fails and prints path, p95, ceiling and margin when p95 is over the ceiling", () => {
      const { failed, lines } = compareToBaseline(run(620), gated);
      expect(failed).toBe(true);
      expect(lines.find((l) => l.includes("p95"))).toMatch(
        /FAIL.*x\/prompt-submit.*p95 620ms.*ceiling 500ms.*margin -120ms/,
      );
    });

    it("passes a p95 at or under the ceiling", () => {
      expect(compareToBaseline(run(500), gated).failed).toBe(false);
      const { failed, lines } = compareToBaseline(run(300), gated);
      expect(failed).toBe(false);
      expect(lines.find((l) => l.includes("p95"))).toMatch(/ok.*p95 300ms.*margin \+200ms/);
    });

    it("never fails a path with no ceiling on latency", () => {
      const slowSearch = { ...run(300), search: { ...stats(0.9, 0.5, 0.5), latencyP95: 99999 } };
      expect(compareToBaseline(slowSearch, gated).failed).toBe(false);
    });

    it("fails a gated path missing from the run", () => {
      const { failed, lines } = compareToBaseline({ x: { search: stats(0.9, 0.5, 0.5) } }, gated);
      expect(failed).toBe(true);
      expect(lines.join("\n")).toMatch(/x\/prompt-submit.*missing/);
    });

    it("fails as missing a gated path whose summary has no p95", () => {
      const { latencyP95: _, ...noP95 } = withP95(0);
      const { failed, lines } = compareToBaseline(
        { x: { "prompt-submit": noP95 as ReturnType<typeof withP95> } },
        gated,
      );
      expect(failed).toBe(true);
      expect(lines.join("\n")).toMatch(/x\/prompt-submit: p95 missing/);
    });
  });
});

describe("summarize latency", () => {
  const timed = (ms: number[]) =>
    summarize(
      ms.map((m, i) =>
        scoreQuestion(question({ id: String(i), goldSessionIds: ["a"] }), ranked("a"), 5, "x", m),
      ),
    );

  it("takes the slowest question as p95 when n is 3", () => {
    expect(timed([30, 10, 20]).latencyP95).toBe(30);
  });

  it("takes the nearest-rank 95th percentile over a larger run", () => {
    const ms = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(timed(ms).latencyP95).toBe(95);
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
    const answerable = queries.filter((q) => questionPath(q) === "search" && q.goldSessionIds.length > 0);
    let hits = 0;
    for (const q of answerable) {
      const { ranked } = await grepAdapter.query(q, state, 5);
      if (ranked.some((r) => q.goldSessionIds.includes(r.sessionId))) hits += 1;
    }
    expect(hits / answerable.length).toBeGreaterThan(0.5);
  });

  it("asks the prompt-submit path to stay empty on a bare acknowledgement", () => {
    const acks = queries.filter((q) => questionPath(q) === "prompt-submit" && q.type === "acknowledgement");
    expect(acks.length).toBeGreaterThan(0);
    expect(acks.every((q) => q.goldSessionIds.length === 0)).toBe(true);
  });

  it("has no-answer questions on every path", () => {
    for (const path of ["search", "session-start", "prompt-submit"]) {
      expect(queries.some((q) => questionPath(q) === path && q.goldSessionIds.length === 0)).toBe(
        true,
      );
    }
  });

  it("rates every captured Observation on more than one importance value", () => {
    const observations = sessions.flatMap((s) => s.observations ?? []);
    expect(observations.every((o) => Number.isInteger(o.importance) && o.importance! >= 1 && o.importance! <= 10)).toBe(true);
    expect(new Set(observations.map((o) => o.importance)).size).toBeGreaterThan(1);
    expect(() => assertVariedImportance(sessions)).not.toThrow();
  });

  it("keeps pinned-rule fixtures out of this corpus, so they cannot shift its gated numbers", () => {
    expect(sessions.some((s) => s.memoryType === "rule")).toBe(false);
  });

  it("refuses a rated dataset that rates everything alike", () => {
    const flat: Session[] = [{ id: "s", observations: [{ tool: "Read", output: "a", importance: 5 }, { tool: "Read", output: "b", importance: 5 }] }];
    expect(() => assertVariedImportance(flat)).toThrow(/one importance/);
  });
});

describe("pinned-rules dataset", () => {
  const dir = new URL("../eval/data/pinned-rules/", import.meta.url);
  const sessions = JSON.parse(readFileSync(new URL("sessions.json", dir), "utf8")) as Session[];
  const queries = JSON.parse(readFileSync(new URL("queries.json", dir), "utf8")) as Question[];
  const byId = new Map(sessions.map((s) => [s.id, s]));

  it("points every rule question at a rule of its own project", () => {
    const ruleQuestions = queries.filter((q) => q.type.startsWith("rule-"));
    expect(ruleQuestions.length).toBeGreaterThan(0);
    for (const q of ruleQuestions) {
      for (const gold of q.goldSessionIds) {
        expect(byId.get(gold), `${q.id} -> ${gold}`).toMatchObject({ memoryType: "rule", project: q.project });
      }
    }
  });

  it("asks both session start and pre-compact for a buried rule, an amended rule and nothing", () => {
    for (const path of ["session-start", "pre-compact"]) {
      const types = queries.filter((q) => questionPath(q) === path).map((q) => q.type);
      expect(types, path).toEqual(expect.arrayContaining(["rule-buried", "rule-amended", "no-answer"]));
    }
  });

  it("gives every Observation and rule a needle no other Session shares", () => {
    const owner = new Map<string, string>();
    for (const s of sessions) {
      const texts = [...(s.observations ?? []).map((o) => o.output), ...(s.content ? [s.content] : [])];
      for (const text of texts) {
        const needle = needleFor(text);
        const prev = owner.get(needle);
        expect(prev === undefined || prev === s.id, `${s.id} shares "${needle}" with ${prev}`).toBe(true);
        owner.set(needle, s.id);
      }
    }
  });

  it("rates its Observations on more than one importance value", () => {
    expect(() => assertVariedImportance(sessions)).not.toThrow();
  });
});
