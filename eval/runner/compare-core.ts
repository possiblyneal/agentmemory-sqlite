export interface DecisionItem {
  decisionId: string;
  turn: number;
  sessionStart: boolean;
  promptSubmit: boolean;
  promptSubmitByTurn?: boolean;
  reachable?: boolean;
}

export interface DecisionRow {
  sessionId: string;
  decisions?: DecisionItem[];
}

export interface Pairing {
  both: number;
  aOnly: number;
  bOnly: number;
  neither: number;
  aDelivered: number;
  bDelivered: number;
}

const itemKey = (sessionId: string, d: DecisionItem) => `${sessionId}\t${d.turn}\t${d.decisionId}`;

// `same-turn` credits the prompt-context Injection of the item's own turn;
// `by-turn` also credits an earlier one of its Session (promptSubmitByTurn).
export type PromptCredit = "same-turn" | "by-turn";

function reachableItems(rows: DecisionRow[], credit: PromptCredit): Map<string, boolean> {
  const items = new Map<string, boolean>();
  for (const row of rows) {
    for (const d of row.decisions ?? []) {
      const prompt = credit === "by-turn" ? d.promptSubmitByTurn === true : d.promptSubmit;
      if (d.reachable !== false) items.set(itemKey(row.sessionId, d), d.sessionStart || prompt);
    }
  }
  return items;
}

// A run probed before promptSubmitByTurn existed cannot be paired by turn.
export const recordsByTurn = (rows: DecisionRow[]): boolean =>
  rows.every((row) => (row.decisions ?? []).every((d) => d.reachable === false || d.promptSubmitByTurn !== undefined));

// Items delivered by either surface, paired over those both runs scored as reachable.
export function pairDecisions(a: DecisionRow[], b: DecisionRow[], credit: PromptCredit = "same-turn"): Pairing {
  const aItems = reachableItems(a, credit);
  const bItems = reachableItems(b, credit);
  const out: Pairing = { both: 0, aOnly: 0, bOnly: 0, neither: 0, aDelivered: 0, bDelivered: 0 };
  for (const [key, aHit] of aItems) {
    const bHit = bItems.get(key);
    if (bHit === undefined) continue;
    if (aHit) out.aDelivered++;
    if (bHit) out.bDelivered++;
    if (aHit && bHit) out.both++;
    else if (aHit) out.aOnly++;
    else if (bHit) out.bOnly++;
    else out.neither++;
  }
  return out;
}

export interface LabelledRows {
  label: string;
  rows: DecisionRow[];
}

// The second compare line: the same pairing with prompt-submit credited by
// turn. McNemar stays on the same-turn pairing above it.
export function cumulativeLine(a: LabelledRows, b: LabelledRows): string {
  const missing = [a, b].filter((r) => !recordsByTurn(r.rows)).map((r) => r.label);
  if (missing.length > 0) return `  delivered by turn: not recorded by ${missing.join(", ")}; rerun its probe`;
  const p = pairDecisions(a.rows, b.rows, "by-turn");
  return `  delivered by turn: A ${p.aDelivered}   B ${p.bDelivered}   both ${p.both}   A-only ${p.aOnly}   B-only ${p.bOnly}   neither ${p.neither}`;
}

// Two-sided exact McNemar: twice the lower tail of Binomial(b + c, 1/2), capped at 1.
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let term = Math.exp(-n * Math.LN2);
  let tail = term;
  for (let i = 1; i <= k; i++) {
    term *= (n - i + 1) / i;
    tail += term;
  }
  return Math.min(1, 2 * tail);
}

export interface RunFailures {
  label: string;
  failedSummarizeCalls: number | undefined;
}

export function refuseFailedSummaries(runs: RunFailures[]): string | undefined {
  const bad = runs.filter((r) => (r.failedSummarizeCalls ?? 0) > 0);
  if (bad.length === 0) return undefined;
  return `not a measurement: ${bad.map((r) => `${r.label} had ${r.failedSummarizeCalls} failed summarize calls`).join("; ")}`;
}
