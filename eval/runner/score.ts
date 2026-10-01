import { questionPath, type Question, type QueryResult, type ScoreRow } from "./types.js";

// Precision is gold hits over what was actually returned, so a near-miss
// costs the score even when the gold item is also present. Returning
// nothing is vacuously precise; an answerable question pays for that in
// recall instead. Recall is undefined for a question with no gold.
export function scoreQuestion(
  q: Question,
  result: QueryResult,
  k: number,
  adapter: string,
  latencyMs: number,
): ScoreRow {
  const path = questionPath(q);
  const ranked = path === "search" ? result.ranked.slice(0, k) : result.ranked;
  const returnedIds = ranked.map((r) => r.sessionId);
  const gold = new Set(q.goldSessionIds);
  const answerable = gold.size > 0;
  const hits = returnedIds.filter((id) => gold.has(id)).length;
  const precision = returnedIds.length === 0 ? 1 : hits / returnedIds.length;
  const recall = answerable ? hits / gold.size : null;
  const hit = answerable ? hits > 0 : returnedIds.length === 0;
  const goldIndex = returnedIds.findIndex((id) => gold.has(id));
  return {
    questionId: q.id,
    questionType: q.type,
    path,
    adapter,
    k,
    returned: returnedIds.length,
    returnedIds,
    answerable,
    precision,
    recall,
    hit,
    topGoldRank: goldIndex === -1 ? null : goldIndex + 1,
    chars: result.chars ?? null,
    latencyMs,
  };
}

export interface PathStats {
  n: number;
  answerable: number;
  recall: number;
  precision: number;
  noAnswerClean: number | null;
  hit: number;
  meanChars: number | null;
  latencyP50: number;
}

export type Summary = Record<string, Record<string, PathStats>>;

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function summarize(rows: ScoreRow[]): PathStats {
  const answerable = rows.filter((r) => r.answerable);
  const noAnswer = rows.filter((r) => !r.answerable);
  const chars = rows.map((r) => r.chars).filter((t): t is number => t !== null);
  const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    n: rows.length,
    answerable: answerable.length,
    recall: mean(answerable.map((r) => r.recall ?? 0)),
    precision: mean(rows.map((r) => r.precision)),
    noAnswerClean:
      noAnswer.length === 0
        ? null
        : noAnswer.filter((r) => r.returned === 0).length / noAnswer.length,
    hit: rows.filter((r) => r.hit).length,
    meanChars: chars.length === 0 ? null : mean(chars),
    latencyP50: latencies[Math.floor(latencies.length / 2)] ?? 0,
  };
}

export function aggregate(rows: ScoreRow[]): Summary {
  const groups = new Map<string, Map<string, ScoreRow[]>>();
  for (const r of rows) {
    const byPath = groups.get(r.adapter) ?? new Map<string, ScoreRow[]>();
    groups.set(r.adapter, byPath);
    byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
  }
  const summary: Summary = {};
  for (const [adapter, byPath] of groups) {
    summary[adapter] = {};
    for (const [path, pathRows] of byPath) summary[adapter][path] = summarize(pathRows);
  }
  return summary;
}
