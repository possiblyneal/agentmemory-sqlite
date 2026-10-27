import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { operatorInputs } from "../eval/runner/decision-inputs.js";
import { buildDecisionKey, loadOrBuildKey, type Complete, type DecisionKey } from "../eval/runner/decision-key.js";
import { createJudge, decisionOutcomes, openVerdictCache } from "../eval/runner/decision-judge.js";
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

function probe(kind: Probe["kind"], turn: number, text: string): Probe {
  return { kind, turn, latencyMs: 1, chars: text.length, items: [], text };
}

describe("decision recall", () => {
  const { session } = load("s2", "2026-09-02T10:00:00Z", [user("add the orders repository"), user("list orders")]);
  const key: DecisionKey = {
    version: 1,
    builtAt: "x",
    decisions: [decision, { ...decision, id: "d2", text: "Totals are in cents." }],
    expected: [{ sessionId: "s2", turn: 1, decisionIds: ["d1", "d2"] }],
  };
  const complete: Complete = async (_system, u) => {
    const text = u.split("Injected text:\n")[1];
    const wanted = u.includes("query builder") ? "builder" : "cents";
    return `{"delivers":${text.includes(wanted)}}`;
  };

  it("judges each expected decision against the session-start and prompt-context Injection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-verdicts-"));
    try {
      const judge = createJudge(complete, openVerdictCache(join(dir, "v.ndjson")));
      const outcomes = await decisionOutcomes(session, key, [probe("session-start", 0, "all totals are cents"), probe("prompt-context", 1, "use the builder")], judge);
      expect(outcomes).toEqual([
        { decisionId: "d1", turn: 1, sessionStart: false, promptSubmit: true },
        { decisionId: "d2", turn: 1, sessionStart: true, promptSubmit: false },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
        { decisionId: "d1", turn: 1, sessionStart: true, promptSubmit: false },
        { decisionId: "d2", turn: 1, sessionStart: false, promptSubmit: false },
      ]),
      score("b", "agentmemory-sqlite", [{ decisionId: "d3", turn: 2, sessionStart: false, promptSubmit: true }]),
      score("c", "shop", undefined),
    ];
    const s = summarizeReplay(scores, { storeBytesStart: 0, storeBytesEnd: 0 });
    expect(s.decisionRecall).toEqual({
      items: 3,
      sessionStart: { n: 3, hit: 1, share: 1 / 3 },
      promptSubmit: { n: 3, hit: 1, share: 1 / 3 },
      either: { n: 3, hit: 2, share: 2 / 3 },
    });
    expect(s.byProject.shop.decisionRecall.items).toBe(2);
    expect(s.byProject["agentmemory-sqlite"].decisionRecall.promptSubmit.hit).toBe(1);
    expect(s.typical.summary.decisionRecall).toMatchObject({ items: 2, sessionStart: { hit: 1 }, either: { hit: 1 } });
  });
});
