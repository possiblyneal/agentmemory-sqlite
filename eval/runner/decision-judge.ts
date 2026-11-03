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
  delivers(decision: Decision, injected: string): Promise<boolean>;
}

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

// A Session's expected decisions, judged against the session-start Injection
// and against the prompt-context Injection of the prompt they bear on.
export async function decisionOutcomes(
  session: ReplaySession,
  key: DecisionKey,
  probes: Probe[],
  judge: Judge,
): Promise<DecisionOutcome[]> {
  const byId = new Map(key.decisions.map((d) => [d.id, d]));
  const start = probes.find((p) => p.kind === "session-start" && !p.failed)?.text ?? "";
  const out: DecisionOutcome[] = [];
  for (const expected of key.expected.filter((e) => e.sessionId === session.id)) {
    const prompt = probes.find((p) => p.kind === "prompt-context" && p.turn === expected.turn && !p.failed)?.text ?? "";
    for (const id of expected.decisionIds) {
      const decision = byId.get(id);
      if (!decision) continue;
      const [sessionStart, promptSubmit] = await Promise.all([judge.delivers(decision, start), judge.delivers(decision, prompt)]);
      out.push({ decisionId: id, turn: expected.turn, sessionStart, promptSubmit });
    }
  }
  return out;
}
