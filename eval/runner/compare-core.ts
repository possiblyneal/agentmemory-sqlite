export interface DecisionItem {
  decisionId: string;
  turn: number;
  sessionStart: boolean;
  promptSubmit: boolean;
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

function reachableItems(rows: DecisionRow[]): Map<string, boolean> {
  const items = new Map<string, boolean>();
  for (const row of rows) {
    for (const d of row.decisions ?? []) {
      if (d.reachable !== false) items.set(itemKey(row.sessionId, d), d.sessionStart || d.promptSubmit);
    }
  }
  return items;
}

// Items delivered by either surface, paired over those both runs scored as reachable.
export function pairDecisions(a: DecisionRow[], b: DecisionRow[]): Pairing {
  const aItems = reachableItems(a);
  const bItems = reachableItems(b);
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
