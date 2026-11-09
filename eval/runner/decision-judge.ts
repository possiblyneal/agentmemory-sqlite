import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Complete, Decision, DecisionKey } from "./decision-key.js";
import type { DecisionOutcome, Probe } from "./replay-score.js";
import type { ReplaySession } from "./replay-transcript.js";

const MAX_JUDGED_CHARS = 20_000;

const JUDGE_SYSTEM = `You judge whether a memory system handed a coding Agent a decision the Operator had made.
Given the decision and the text injected into the Agent's context, answer whether the injected text delivers the decision: it states it or clearly implies it, so an Agent reading it would know it. A paraphrase counts. A passing mention of the same topic without the decision does not.
Reply with JSON only: {"delivers":true} or {"delivers":false}.`;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// Verdicts persist as ndjson rows keyed by (decision id, hash of the injected
// text), so an unchanged rerun asks the judge nothing.
export interface VerdictCache {
  get(decisionId: string, text: string): boolean | undefined;
  set(decisionId: string, text: string, delivers: boolean): void;
}

export function openVerdictCache(path: string): VerdictCache {
  const verdicts = new Map<string, boolean>();
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { k: string; v: boolean };
      verdicts.set(row.k, row.v);
    }
  }
  const keyOf = (id: string, text: string) => `${id}:${sha256(text)}`;
  return {
    get: (id, text) => verdicts.get(keyOf(id, text)),
    set(id, text, delivers) {
      const k = keyOf(id, text);
      verdicts.set(k, delivers);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify({ k, v: delivers })}\n`);
    },
  };
}

export interface Judge {
  delivers(decision: Pick<Decision, "id" | "text">, injected: string): Promise<boolean>;
}

export const asDecisionList = (decisions: string[]) => decisions.map((d) => `- ${d}`).join("\n");

export function createJudge(complete: Complete, cache: VerdictCache): Judge {
  return {
    async delivers(decision, injected) {
      if (injected.trim() === "") return false;
      const cached = cache.get(decision.id, injected);
      if (cached !== undefined) return cached;
      const reply = await complete(
        JUDGE_SYSTEM,
        `Decision: ${decision.text}\n\nInjected text:\n${injected.slice(0, MAX_JUDGED_CHARS)}`,
      );
      const delivers = /"delivers"\s*:\s*true/i.test(reply);
      cache.set(decision.id, injected, delivers);
      return delivers;
    },
  };
}

// The prompt-context Injections before `turn` that the Agent still holds at
// it: those since the last compaction before it, newest first.
function earlierInWindow(session: ReplaySession, prompts: Probe[], turn: number): Probe[] {
  const since = Math.max(0, ...session.compactedAfter.filter((c) => c < turn));
  return prompts.filter((p) => p.turn > since && p.turn < turn).sort((a, b) => b.turn - a.turn);
}

// A decision missed at its own turn is still delivered by that turn when an
// earlier Injection in its window delivers it; the judge stops at the first.
async function deliveredEarlier(decision: Decision, earlier: Probe[], judge: Judge): Promise<boolean> {
  for (const probe of earlier) {
    if (await judge.delivers(decision, probe.text ?? "")) return true;
  }
  return false;
}

// A Session's expected decisions, judged against the session-start Injection
// and against the prompt-context Injection of the prompt they bear on, and
// for promptSubmitByTurn against the Session's earlier prompt-context
// Injections too. A decision made in a Session that was not replayed before
// this one is in no store the daemon could hold, so it is reported
// unreachable and not judged.
export async function decisionOutcomes(
  session: ReplaySession,
  key: DecisionKey,
  probes: Probe[],
  judge: Judge,
  replayed: ReadonlySet<string>,
): Promise<DecisionOutcome[]> {
  const byId = new Map(key.decisions.map((d) => [d.id, d]));
  const start = probes.find((p) => p.kind === "session-start" && !p.failed)?.text ?? "";
  const prompts = probes.filter((p) => p.kind === "prompt-context" && !p.failed);
  const out: DecisionOutcome[] = [];
  for (const expected of key.expected.filter((e) => e.sessionId === session.id)) {
    const prompt = prompts.find((p) => p.turn === expected.turn)?.text ?? "";
    const earlier = earlierInWindow(session, prompts, expected.turn);
    for (const id of expected.decisionIds) {
      const decision = byId.get(id);
      if (!decision) continue;
      if (!replayed.has(decision.sessionId)) {
        out.push({ decisionId: id, turn: expected.turn, reachable: false, sessionStart: false, promptSubmit: false, promptSubmitByTurn: false });
        continue;
      }
      const [sessionStart, promptSubmit] = await Promise.all([judge.delivers(decision, start), judge.delivers(decision, prompt)]);
      const promptSubmitByTurn = promptSubmit || (await deliveredEarlier(decision, earlier, judge));
      out.push({ decisionId: id, turn: expected.turn, reachable: true, sessionStart, promptSubmit, promptSubmitByTurn });
    }
  }
  return out;
}
