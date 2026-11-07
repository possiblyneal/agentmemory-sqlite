import { DatabaseSync } from "node:sqlite";
import { MAX_DECISIONS } from "../../src/functions/prompt-context.js";
import type { Decision } from "./decision-key.js";
import type { Judge } from "./decision-judge.js";

export const MISS_LABELS = ["no-summary", "not-in-summary", "beyond-render-cap", "in-render-cap"] as const;
export type MissLabel = (typeof MISS_LABELS)[number];

const asList = (decisions: string[]) => decisions.map((d) => `- ${d}`).join("\n");

// Where a key decision is lost on its way into an Injection: its origin
// Session has no Summary, the Summary never states it, it sits past the
// decisions an Injection renders, or it is among them.
export async function attributeDecision(decision: Decision, keyDecisions: string[] | undefined, judge: Judge): Promise<MissLabel> {
  if (!keyDecisions) return "no-summary";
  if (!(await judge.delivers(decision, asList(keyDecisions)))) return "not-in-summary";
  if (!(await judge.delivers(decision, asList(keyDecisions.slice(0, MAX_DECISIONS))))) return "beyond-render-cap";
  return "in-render-cap";
}

export function readSummaryDecisions(sqlitePath: string, sessionId: string): string[] | undefined {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const row = db.prepare("select value from kv where scope = ? and key = ?").get("mem:summaries", sessionId) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as { keyDecisions?: string[] }).keyDecisions : undefined;
  } finally {
    db.close();
  }
}
