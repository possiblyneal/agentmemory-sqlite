export interface Call {
  ms: number;
  // The hook gave up at its deadline: the call counts as late, whatever the daemon did next.
  timedOut: boolean;
}

export interface Latency {
  n: number;
  inTime: number;
  p50: number;
  p95: number;
  max: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function latency(calls: Call[], deadlineMs: number): Latency {
  const ms = calls.map((c) => c.ms).sort((a, b) => a - b);
  return {
    n: calls.length,
    inTime: calls.filter((c) => !c.timedOut && c.ms <= deadlineMs).length,
    p50: Math.round(percentile(ms, 50)),
    p95: Math.round(percentile(ms, 95)),
    max: Math.round(ms.at(-1) ?? 0),
  };
}

// Deterministic, so two builds see the same burst.
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RunResult {
  label: string;
  run: number;
  loadBefore: number;
  sessions: number;
  firstPrompt: Latency;
  sessionStart: Latency;
  laterPrompt: Latency;
  livez: { n: number; p95: number; max: number };
}

export interface Summary {
  label: string;
  runs: number;
  firstInTime: number[];
  firstInTimeMedian: number;
  firstP50Median: number;
  laterP95Median: number;
  livezMax: number;
}

export function summarizeRuns(label: string, runs: RunResult[]): Summary {
  const median = (xs: number[]) => percentile([...xs].sort((a, b) => a - b), 50);
  return {
    label,
    runs: runs.length,
    firstInTime: runs.map((r) => r.firstPrompt.inTime),
    firstInTimeMedian: median(runs.map((r) => r.firstPrompt.inTime)),
    firstP50Median: median(runs.map((r) => r.firstPrompt.p50)),
    laterP95Median: median(runs.map((r) => r.laterPrompt.p95)),
    livezMax: Math.max(0, ...runs.map((r) => r.livez.max)),
  };
}
