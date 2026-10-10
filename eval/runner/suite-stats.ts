import { mulberry32 } from "./adapters/random.js";

// Every suite metric pools a numerator over a denominator across items, so a
// replay share weights each Session by its size and a per-question mean is
// just den = 1.
export interface Ratio {
  num: number;
  den: number;
}

export type ItemMetrics = Record<string, Record<string, Ratio>>;

export interface Comparison {
  n: number;
  base: number | null;
  cand: number | null;
  delta: number | null;
  low: number | null;
  high: number | null;
  verdict: "better" | "worse" | "≈";
}

const RESAMPLES = 2000;
const SEED = 20261010;

function pool(ratios: Ratio[]): number | null {
  const den = ratios.reduce((n, r) => n + r.den, 0);
  return den === 0 ? null : ratios.reduce((n, r) => n + r.num, 0) / den;
}

export function pooled(items: Record<string, Ratio>): number | null {
  return pool(Object.values(items));
}

// Paired over the items both runs scored, resampling items rather than runs:
// it says whether the change moved these items, not whether a rerun of the
// same commit would land in the same place.
export function pairedBootstrap(
  base: Record<string, Ratio>,
  cand: Record<string, Ratio>,
  lowerIsBetter = false,
): Comparison {
  const ids = Object.keys(base).filter((id) => id in cand).sort();
  const b = ids.map((id) => base[id]);
  const c = ids.map((id) => cand[id]);
  const baseValue = pool(b);
  const candValue = pool(c);
  if (baseValue === null || candValue === null) {
    return { n: ids.length, base: baseValue, cand: candValue, delta: null, low: null, high: null, verdict: "≈" };
  }
  const next = mulberry32(SEED);
  const deltas: number[] = [];
  for (let r = 0; r < RESAMPLES; r++) {
    const pick = ids.map(() => Math.floor(next() * ids.length));
    const pc = pool(pick.map((i) => c[i]));
    const pb = pool(pick.map((i) => b[i]));
    if (pc !== null && pb !== null) deltas.push(pc - pb);
  }
  deltas.sort((x, y) => x - y);
  const low = deltas[Math.floor(deltas.length * 0.025)];
  const high = deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.975))];
  const up = low > 0;
  const down = high < 0;
  const verdict = up || down ? ((up !== lowerIsBetter) ? "better" : "worse") : "≈";
  return { n: ids.length, base: baseValue, cand: candValue, delta: candValue - baseValue, low, high, verdict };
}
