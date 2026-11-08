import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { operatorInputs } from "../eval/runner/decision-inputs.js";
import { buildDecisionKey, loadOrBuildKey, type Complete, type DecisionKey } from "../eval/runner/decision-key.js";
import { DatabaseSync } from "node:sqlite";
import { MAX_DECISIONS } from "../src/functions/prompt-context.js";
import { attributeDecision, readSummaryDecisions, type MissLabel } from "../eval/runner/decision-attribution.js";
import { createJudge, decisionOutcomes, openVerdictCache, type Judge } from "../eval/runner/decision-judge.js";
import { withRetries } from "../eval/runner/decision-llm.js";
import { summarizeReplay, type Probe, type SessionScore } from "../eval/runner/replay-score.js";
import { parseTranscript, type ReplaySession } from "../eval/runner/replay-transcript.js";

const CWD = "/synthetic/shop";

type Line = Record<string, unknown>;

function jsonl(sessionId: string, start: string, lines: Line[]): string {
  const base = Date.parse(start);
  return lines
    .map((l, i) => JSON.stringify({ sessionId, cwd: CWD, timestamp: new Date(base + i * 1000).toISOString(), ...l }))
    .join("\n");
}

const user = (content: unknown): Line => ({ type: "user", message: { role: "user", content } });
const assistant = (content: unknown[]): Line => ({ type: "assistant", message: { role: "assistant", content } });

function load(id: string, start: string, lines: Line[]): { session: ReplaySession; text: string } {
  const text = jsonl(id, start, lines);
  const session = parseTranscript(text);
  if (!session) throw new Error("no turns");
  return { session, text };
}

const ASK = assistant([
  {
    type: "tool_use",
    id: "ask1",
    name: "AskUserQuestion",
    input: { questions: [{ question: "Which store?", options: [{ label: "sqlite" }, { label: "postgres" }] }] },
  },
]);
const ANSWER = user([
  { type: "tool_result", tool_use_id: "ask1", content: 'User has answered your questions: "Which store?"="sqlite".' },
]);

describe("operatorInputs", () => {
  it("keeps typed turns and AskUserQuestion Q&A, and nothing the Agent or the harness said", () => {
    const { session, text } = load("s1", "2026-09-01T10:00:00Z", [
      user("use the query builder for every repository query"),
      assistant([{ type: "text", text: "AGENT-PROSE-MARKER I will do that" }]),
      ASK,
      ANSWER,
      user("<task-notification>HARNESS-MARKER background job done</task-notification>"),
      user("This session is being continued from a previous conversation. SUMMARY-MARKER"),
      user("<teammate-message>TEAMMATE-MARKER</teammate-message>"),
      user("keep the cart total in cents"),
    ]);
    const inputs = operatorInputs(text, session);
    expect(inputs.map((i) => i.kind)).toEqual(["typed", "ask", "typed"]);
    const all = JSON.stringify(inputs);
    for (const marker of ["AGENT-PROSE-MARKER", "HARNESS-MARKER", "SUMMARY-MARKER", "TEAMMATE-MARKER"]) {
      expect(all).not.toContain(marker);
    }
    expect(inputs[1]).toMatchObject({ kind: "ask", afterTurn: 1, questions: [{ question: "Which store?", options: ["sqlite", "postgres"] }] });
    expect(all).toContain("sqlite");
  });

  it("skips an errored answer", () => {
    const { session, text } = load("s1", "2026-09-01T10:00:00Z", [
      user("pick a store"),
      ASK,
      user([{ type: "tool_result", tool_use_id: "ask1", is_error: true, content: "rejected" }]),
    ]);
    expect(operatorInputs(text, session).map((i) => i.kind)).toEqual(["typed"]);
  });
});

function fakeLlm(): { complete: Complete; calls: Array<{ system: string; user: string }> } {
  const calls: Array<{ system: string; user: string }> = [];
  const complete: Complete = async (system, userPrompt) => {
    calls.push({ system, user: userPrompt });
    if (system.includes("List the decisions")) {
      const n = /\[(\d+)\] Operator typed: use the query builder/.exec(userPrompt)?.[1];
      return n ? `{"decisions":[{"input":${n},"decision":"Repository queries use the query builder."}]}` : '{"decisions":[]}';
    }
    if (system.includes("match an Operator")) {
      const id = /^(\S+): Repository queries/m.exec(userPrompt)?.[1];
      const turn = /\[(\d+)\] add the orders repository/.exec(userPrompt)?.[1];
      return id && turn ? `{"prompts":[{"prompt":${turn},"decisions":["${id}","bogus-id"]}]}` : '{"prompts":[]}';
    }
    return '{"delivers":false}';
  };
  return { complete, calls };
}

function twoSessions() {
  const a = load("aaaaaaaa-1", "2026-09-01T10:00:00Z", [user("use the query builder for every repository query"), user("thanks, finish the cart module")]);
  const b = load("bbbbbbbb-2", "2026-09-02T10:00:00Z", [user("add the orders repository please"), user("now list the orders by date")]);
  return [a, b].map(({ session, text }) => ({ session, inputs: operatorInputs(text, session) }));
}

describe("buildDecisionKey", () => {
  it("extracts decisions from operator inputs only and labels later prompts with earlier decisions", async () => {
    const { complete, calls } = fakeLlm();
    const key = await buildDecisionKey(twoSessions(), complete);
    expect(key.decisions).toHaveLength(1);
    expect(key.decisions[0]).toMatchObject({ sessionId: "aaaaaaaa-1", source: "typed", project: "shop" });
    expect(key.expected).toEqual([{ sessionId: "bbbbbbbb-2", turn: 1, decisionIds: [key.decisions[0].id] }]);
    expect(calls.every((c) => !c.user.includes("AGENT"))).toBe(true);
  });
});

describe("loadOrBuildKey", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  const key: DecisionKey = { version: 1, builtAt: "2026-10-27T00:00:00.000Z", decisions: [], expected: [] };

  it("reuses the frozen key without --rebuild and rebuilds with it", async () => {
    dir = mkdtempSync(join(tmpdir(), "decision-key-"));
    const path = join(dir, "key.json");
    let builds = 0;
    const build = async () => ({ ...key, builtAt: `build-${++builds}` });
    expect((await loadOrBuildKey(path, false, build)).reused).toBe(false);
    expect(existsSync(path)).toBe(true);
    const again = await loadOrBuildKey(path, false, build);
    expect(again).toMatchObject({ reused: true, key: { builtAt: "build-1" } });
    expect(builds).toBe(1);
    const rebuilt = await loadOrBuildKey(path, true, build);
    expect(rebuilt).toMatchObject({ reused: false, key: { builtAt: "build-2" } });
    expect(JSON.parse(readFileSync(path, "utf8")).builtAt).toBe("build-2");
  });
});

const decision = { id: "d1", sessionId: "e1", project: "shop", source: "typed" as const, text: "Use the query builder." };

describe("judge cache", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("asks the judge once per (decision, injected text), across reopen", async () => {
    dir = mkdtempSync(join(tmpdir(), "decision-verdicts-"));
    const path = join(dir, "verdicts.ndjson");
    let calls = 0;
    const complete: Complete = async () => {
      calls++;
      return '{"delivers":true}';
    };
    const first = createJudge(complete, openVerdictCache(path));
    expect(await first.delivers(decision, "query builder everywhere")).toBe(true);
    expect(await first.delivers(decision, "query builder everywhere")).toBe(true);
    expect(calls).toBe(1);
    const reopened = createJudge(complete, openVerdictCache(path));
    expect(await reopened.delivers(decision, "query builder everywhere")).toBe(true);
    expect(calls).toBe(1);
    await reopened.delivers(decision, "different text");
    expect(calls).toBe(2);
  });

  it("does not call the judge for an empty Injection", async () => {
    dir = mkdtempSync(join(tmpdir(), "decision-verdicts-"));
    const judge = createJudge(async () => {
      throw new Error("should not be called");
    }, openVerdictCache(join(dir, "v.ndjson")));
    expect(await judge.delivers(decision, "  ")).toBe(false);
  });
});

describe("withRetries", () => {
  it("retries a thrown call and gives up after the last attempt", async () => {
    let calls = 0;
    const flaky: Complete = async () => {
      if (++calls < 3) throw new TypeError("fetch failed");
      return "ok";
    };
    expect(await withRetries(flaky, 3, 0)("s", "u")).toBe("ok");
    calls = -10;
    await expect(withRetries(flaky, 2, 0)("s", "u")).rejects.toThrow("fetch failed");
    expect(calls).toBe(-8);
  });
});

function probe(kind: Probe["kind"], turn: number, text: string): Probe {
  return { kind, turn, latencyMs: 1, chars: text.length, items: [], text };
}

describe("decision recall", () => {
  const { session } = load("s2", "2026-09-02T10:00:00Z", [user("add the orders repository"), user("list orders")]);
  const key: DecisionKey = {
    version: 1,
    builtAt: "x",
    decisions: [
      decision,
      { ...decision, id: "d2", text: "Totals are in cents." },
      { ...decision, id: "d3", sessionId: "gone", text: "Ship on Fridays." },
    ],
    expected: [{ sessionId: "s2", turn: 1, decisionIds: ["d1", "d2", "d3"] }],
  };
  const complete: Complete = async (_system, u) => {
    const text = u.split("Injected text:\n")[1];
    const wanted = u.includes("query builder") ? "builder" : "cents";
    return `{"delivers":${text.includes(wanted)}}`;
  };

  it("judges each reachable decision against the session-start and prompt-context Injection, and never judges one whose Session was not replayed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-verdicts-"));
    let calls = 0;
    const counting: Complete = (system, u) => {
      calls++;
      return complete(system, u);
    };
    try {
      const judge = createJudge(counting, openVerdictCache(join(dir, "v.ndjson")));
      const probes = [probe("session-start", 0, "all totals are cents"), probe("prompt-context", 1, "use the builder")];
      const outcomes = await decisionOutcomes(session, key, probes, judge, new Set(["e1"]));
      expect(outcomes).toEqual([
        { decisionId: "d1", turn: 1, reachable: true, sessionStart: false, promptSubmit: true, promptSubmitByTurn: true },
        { decisionId: "d2", turn: 1, reachable: true, sessionStart: true, promptSubmit: false, promptSubmitByTurn: false },
        { decisionId: "d3", turn: 1, reachable: false, sessionStart: false, promptSubmit: false, promptSubmitByTurn: false },
      ]);
      expect(calls).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("delivered by turn", () => {
    const { session: compacted } = load("s3", "2026-09-03T10:00:00Z", [
      user("add the orders repository"),
      user("list orders"),
      { ...user("This session is being continued from a previous conversation that ran out of context."), isCompactSummary: true },
      user("now totals"),
      user("ship it"),
    ]);
    const cents = { ...decision, id: "d2", text: "Totals are in cents." };
    const probes = [
      probe("prompt-context", 1, "use the builder"),
      probe("prompt-context", 2, "totals in cents"),
      probe("prompt-context", 3, "totals stay in cents"),
      probe("prompt-context", 4, "nothing relevant"),
    ];
    const judged: number[] = [];
    const judge: Judge = {
      delivers: async (d, injected) => {
        judged.push(probes.find((p) => p.text === injected)?.turn ?? -1);
        return injected.includes(d.id === "d1" ? "builder" : "cents");
      },
    };
    const outcome = async (id: string, turn: number) => {
      const key: DecisionKey = { version: 1, builtAt: "x", decisions: [decision, cents], expected: [{ sessionId: "s3", turn, decisionIds: [id] }] };
      const [o] = await decisionOutcomes(compacted, key, probes, judge, new Set(["e1"]));
      return o;
    };

    it("records each compaction after the Operator turns before it", () => {
      expect(compacted.compactedAfter).toEqual([2]);
    });

    it("credits a decision an earlier prompt-context Injection of the Session delivered, leaving same-turn unchanged", async () => {
      expect(await outcome("d1", 2)).toMatchObject({ promptSubmit: false, promptSubmitByTurn: true });
    });

    it("does not credit a decision delivered only after its turn", async () => {
      expect(await outcome("d2", 1)).toMatchObject({ promptSubmit: false, promptSubmitByTurn: false });
    });

    it("does not credit a decision delivered before a compaction that precedes its turn", async () => {
      judged.length = 0;
      expect(await outcome("d1", 4)).toMatchObject({ promptSubmit: false, promptSubmitByTurn: false });
      expect(await outcome("d2", 4)).toMatchObject({ promptSubmit: false, promptSubmitByTurn: true });
      expect(judged.filter((t) => t === 1 || t === 2)).toEqual([]);
    });
  });

  it("aggregates recall per surface, by project and for typical", () => {
    const score = (id: string, project: string, decisions: SessionScore["decisions"]): SessionScore => ({
      sessionId: id,
      project,
      startedAt: "2026-09-02T10:00:00Z",
      turns: 1,
      failedProbes: 0,
      injectionChars: 0,
      items: [],
      outcomes: [],
      decisions,
      latencies: [],
    });
    const scores = [
      score("a", "shop", [
        { decisionId: "d1", turn: 1, reachable: true, sessionStart: true, promptSubmit: false, promptSubmitByTurn: false },
        { decisionId: "d2", turn: 1, reachable: true, sessionStart: false, promptSubmit: false, promptSubmitByTurn: true },
        { decisionId: "d4", turn: 1, reachable: false, sessionStart: false, promptSubmit: false, promptSubmitByTurn: false },
      ]),
      score("b", "agentmemory-sqlite", [{ decisionId: "d3", turn: 2, reachable: true, sessionStart: false, promptSubmit: true, promptSubmitByTurn: true }]),
      score("c", "shop", undefined),
    ];
    const s = summarizeReplay(scores, { storeBytesStart: 0, storeBytesEnd: 0 });
    expect(s.decisionRecall).toEqual({
      items: 3,
      unreachable: 1,
      sessionStart: { n: 3, hit: 1, share: 1 / 3 },
      promptSubmit: { n: 3, hit: 1, share: 1 / 3 },
      promptSubmitByTurn: { n: 3, hit: 2, share: 2 / 3 },
      either: { n: 3, hit: 2, share: 2 / 3 },
    });
    expect(s.byProject.shop.decisionRecall.items).toBe(2);
    expect(s.byProject["agentmemory-sqlite"].decisionRecall.promptSubmit.hit).toBe(1);
    expect(s.typical.summary.decisionRecall).toMatchObject({ items: 2, sessionStart: { hit: 1 }, either: { hit: 1 } });
  });
});

describe("decision attribution", () => {
  const decision = { id: "d1", sessionId: "e1", project: "shop", source: "typed" as const, text: "money is cents" };
  const judge: Judge = { delivers: async (_d, injected) => injected.includes("cents") };
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `filler ${i}`);

  it("labels where a decision was lost from its origin Session's Summary", async () => {
    expect(await attributeDecision(decision, undefined, judge)).toBe("no-summary");
    expect(await attributeDecision(decision, filler(3), judge)).toBe("not-in-summary");
    expect(await attributeDecision(decision, [...filler(MAX_DECISIONS), "totals in cents"], judge)).toBe("beyond-render-cap");
    expect(await attributeDecision(decision, ["totals in cents", ...filler(20)], judge)).toBe("in-render-cap");
  });

  it("reads a Summary's key decisions from a store, or none", () => {
    const dir = mkdtempSync(join(tmpdir(), "attribution-store-"));
    try {
      const path = join(dir, "s.sqlite");
      const db = new DatabaseSync(path);
      db.exec("create table kv (scope text, key text, value text)");
      db.prepare("insert into kv values (?, ?, ?)").run("mem:summaries", "e1", JSON.stringify({ keyDecisions: ["a", "b"] }));
      db.close();
      expect(readSummaryDecisions(path, "e1")).toEqual(["a", "b"]);
      expect(readSummaryDecisions(path, "missing")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts reachable items per label with how many were delivered, pooled, by project and for typical", () => {
    const d = (decisionId: string, where: MissLabel, delivered: boolean) => ({
      decisionId,
      turn: 1,
      reachable: true,
      sessionStart: delivered,
      promptSubmit: false,
      where,
    });
    const row = (id: string, project: string, outcome: ReturnType<typeof d>): SessionScore => ({
      sessionId: id,
      project,
      startedAt: "2026-09-02T10:00:00Z",
      turns: 1,
      failedProbes: 0,
      injectionChars: 0,
      items: [],
      outcomes: [],
      decisions: [outcome],
      latencies: [],
    });
    const scores = [
      row("a", "shop", d("d1", "in-render-cap", true)),
      row("b", "shop", d("d2", "in-render-cap", false)),
      row("c", "agentmemory-sqlite", d("d3", "not-in-summary", false)),
    ];
    const s = summarizeReplay(scores, { storeBytesStart: 0, storeBytesEnd: 0 });
    expect(s.decisionRecall.attribution).toEqual({
      "no-summary": { n: 0, delivered: 0 },
      "not-in-summary": { n: 1, delivered: 0 },
      "beyond-render-cap": { n: 0, delivered: 0 },
      "in-render-cap": { n: 2, delivered: 1 },
    });
    expect(s.byProject.shop.decisionRecall.attribution?.["in-render-cap"]).toEqual({ n: 2, delivered: 1 });
    expect(s.typical.summary.decisionRecall.attribution?.["not-in-summary"].n).toBe(0);
  });

  it("omits attribution when no item was labelled", () => {
    const s = summarizeReplay([], { storeBytesStart: 0, storeBytesEnd: 0 });
    expect(s.decisionRecall.attribution).toBeUndefined();
  });
});
