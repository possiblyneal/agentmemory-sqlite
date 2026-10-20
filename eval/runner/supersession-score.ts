// Scores one superseded pair on one surface: does the contradicted claim lead
// the newer one? A claim is found by the text it was stored with, so the same
// scorer reads a search page (ordered items) and an Injection (one string).

export type Surface = "search" | "session-start" | "prompt-submit";

export type Kind =
  | "memory"
  | "semantic-fact"
  | "lesson"
  | "insight"
  | "summary-decision"
  | "observation";

// stale-first: the contradicted claim leads, or is all that came back.
// fresh-first: both came back and the newer one leads.
// stale-hidden: only the newer claim came back.
// neither: neither claim came back, so the case says nothing about ranking.
export type Outcome = "stale-first" | "fresh-first" | "stale-hidden" | "neither";

export interface ScoreRow {
  caseId: string;
  kind: Kind;
  variant: string;
  surface: Surface;
  outcome: Outcome;
}

const SEPARATOR = "\n\u0000\n";

export function classify(returned: string[], stale: string, fresh: string): Outcome {
  const text = returned.join(SEPARATOR);
  const s = text.indexOf(stale);
  const f = text.indexOf(fresh);
  if (s === -1 && f === -1) return "neither";
  if (s === -1) return "stale-hidden";
  if (f === -1) return "stale-first";
  return s < f ? "stale-first" : "fresh-first";
}

export interface CellStats {
  n: number;
  staleFirst: number;
  freshFirst: number;
  staleHidden: number;
  neither: number;
  // stale-first over the cases where a claim came back; null when none did.
  staleFirstRate: number | null;
}

export interface CellSummary extends CellStats {
  kind: Kind;
  variant: string | null;
  surface: Surface;
}

function statsOf(rows: ScoreRow[]): CellStats {
  const count = (o: Outcome) => rows.filter((r) => r.outcome === o).length;
  const neither = count("neither");
  const staleFirst = count("stale-first");
  const answered = rows.length - neither;
  return {
    n: rows.length,
    staleFirst,
    freshFirst: count("fresh-first"),
    staleHidden: count("stale-hidden"),
    neither,
    staleFirstRate: answered === 0 ? null : staleFirst / answered,
  };
}

// One summary per (kind, variant, surface), then one rollup per (kind,
// surface) with variant null, in first-seen order.
export function summarize(rows: ScoreRow[]): CellSummary[] {
  const groups = new Map<string, { head: Omit<CellSummary, keyof CellStats>; rows: ScoreRow[] }>();
  const add = (key: string, head: Omit<CellSummary, keyof CellStats>, row: ScoreRow) => {
    const group = groups.get(key) ?? { head, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  };
  for (const row of rows) {
    add(`${row.kind}|${row.variant}|${row.surface}`, { kind: row.kind, variant: row.variant, surface: row.surface }, row);
  }
  for (const row of rows) {
    add(`${row.kind}||${row.surface}`, { kind: row.kind, variant: null, surface: row.surface }, row);
  }
  return [...groups.values()].map(({ head, rows: members }) => ({ ...head, ...statsOf(members) }));
}
