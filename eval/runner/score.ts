import { questionPath, type Question, type QueryResult, type ScoreRow } from "./types.js";

// Returning nothing is vacuously precise; an answerable question pays for
// that in recall instead.
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

function groupStats(
  rows: ScoreRow[],
  outer: (r: ScoreRow) => string,
  inner: (r: ScoreRow) => string,
): Summary {
  const groups = new Map<string, Map<string, ScoreRow[]>>();
  for (const r of rows) {
    const byInner = groups.get(outer(r)) ?? new Map<string, ScoreRow[]>();
    groups.set(outer(r), byInner);
    byInner.set(inner(r), [...(byInner.get(inner(r)) ?? []), r]);
  }
  const summary: Summary = {};
  for (const [o, byInner] of groups) {
    summary[o] = {};
    for (const [i, innerRows] of byInner) summary[o][i] = summarize(innerRows);
  }
  return summary;
}

export function aggregate(rows: ScoreRow[]): { byPath: Summary; byType: Summary } {
  return {
    byPath: groupStats(rows, (r) => r.adapter, (r) => r.path),
    byType: groupStats(rows, (r) => r.questionType, (r) => r.adapter),
  };
}

export type GatedMetric = "recall" | "precision" | "noAnswerClean";

export interface Baseline {
  tolerance: number;
  metrics: Record<string, Record<string, Partial<Record<GatedMetric, number>>>>;
}

export function compareToBaseline(
  summary: Summary,
  baseline: Baseline,
): { failed: boolean; lines: string[] } {
  const lines: string[] = [];
  let failed = false;
  for (const [adapter, byPath] of Object.entries(baseline.metrics)) {
    for (const [path, expected] of Object.entries(byPath)) {
      const actual = summary[adapter]?.[path];
      if (!actual) {
        failed = true;
        lines.push(`FAIL ${adapter}/${path}: missing from this run`);
        continue;
      }
      for (const [metric, floor] of Object.entries(expected) as Array<[GatedMetric, number]>) {
        const got = actual[metric] ?? 0;
        const delta = Number((got - floor).toFixed(3));
        const ok = delta >= -baseline.tolerance;
        if (!ok) failed = true;
        lines.push(
          `${ok ? "ok  " : "FAIL"} ${`${adapter}/${path}`.padEnd(32)} ${metric.padEnd(13)} baseline ${floor.toFixed(3)}  got ${got.toFixed(3)}  ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`,
        );
      }
    }
  }
  return { failed, lines };
}
