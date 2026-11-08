import { createHash } from "node:crypto";
import type { ISdk } from "../../src/engine/types.js";
import type { CompressedObservation, MemoryProvider, Session, SessionSummary } from "../../src/types.js";
import { registerSummarizeFunction } from "../../src/functions/summarize.js";
import { FOLD_SYSTEM } from "../../src/prompts/summary.js";
import { KV, jaccardSimilarity } from "../../src/state/schema.js";
import { asDecisionList, type Judge } from "./decision-judge.js";
import type { Decision } from "./decision-key.js";

export interface FoldDriftOptions {
  sessionId: string;
  project: string;
  batch: number;
}

export type FoldStepKind = "first" | "fold" | "fallback";

export interface FoldStep {
  kind: FoldStepKind;
  decisions: string[];
}

export const DECISION_LABELS = ["never-captured", "dropped-by-fold", "dropped-by-fallback", "kept"] as const;
export type DecisionLabel = (typeof DECISION_LABELS)[number];

export interface Judging {
  judge: Judge;
  key: Decision[];
}

export interface FoldDriftResult {
  sessionId: string;
  observations: number;
  full: number;
  folded: number;
  folds: number;
  fallbacks: number;
  missingExact: number;
  missingLoose: number;
  droppedExact: number;
  droppedLoose: number;
  fallbackDroppedExact: number;
  fallbackDroppedLoose: number;
  missing: string[];
  steps: FoldStep[];
  missingJudged?: number;
  labels?: Array<{ decisionId: string; label: DecisionLabel }>;
  fullSummary: SessionSummary | null;
  foldedSummary: SessionSummary | null;
}

const LOOSE_JACCARD = 0.5;

const normalize = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function memoryKv() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

// Runs the real mem::summarize over a throwaway store, so prompts, the fold
// decision and parsing are the daemon's own.
function summarizer(provider: MemoryProvider, opts: FoldDriftOptions) {
  const kv = memoryKv();
  const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
  const sdk = {
    registerFunction: (id: string, h: (data: unknown) => Promise<unknown>) => void handlers.set(id, h),
  } as unknown as ISdk;
  const calls = { fold: 0, other: 0 };
  const counting: MemoryProvider = {
    ...provider,
    summarize: (system, prompt) => {
      if (system === FOLD_SYSTEM) calls.fold++;
      else calls.other++;
      return provider.summarize(system, prompt);
    },
  };
  registerSummarizeFunction(sdk, kv as never, counting);
  const session: Session = { id: opts.sessionId, project: opts.project } as Session;
  return {
    calls: () => ({ ...calls }),
    async run(observations: CompressedObservation[]): Promise<SessionSummary | null> {
      await kv.set(KV.sessions, opts.sessionId, session);
      for (const o of observations) await kv.set(KV.observations(opts.sessionId), o.id, o);
      const r = (await handlers.get("mem::summarize")!({ sessionId: opts.sessionId })) as {
        success: boolean;
        error?: string;
        summary?: SessionSummary;
      };
      if (!r.success) throw new Error(`summarize ${opts.sessionId} failed: ${r.error}`);
      return r.summary ?? null;
    },
  };
}

export async function measureFoldDrift(
  provider: MemoryProvider,
  observations: CompressedObservation[],
  opts: FoldDriftOptions,
  judging?: Judging,
): Promise<FoldDriftResult> {
  const fullSummary = await summarizer(provider, opts).run(observations);
  const full = fullSummary?.keyDecisions ?? [];

  const sequence = summarizer(provider, opts);
  let last: SessionSummary | null = null;
  const steps: FoldStep[] = [];
  let folds = 0;
  let fallbacks = 0;
  let droppedExact = 0;
  let droppedLoose = 0;
  let fallbackDroppedExact = 0;
  let fallbackDroppedLoose = 0;
  for (let end = opts.batch; ; end += opts.batch) {
    const cut = Math.min(end, observations.length);
    const before = sequence.calls();
    const prior = last?.keyDecisions ?? [];
    last = await sequence.run(observations.slice(0, cut));
    const after = sequence.calls();
    steps.push({
      kind: end === opts.batch ? "first" : after.other > before.other ? "fallback" : "fold",
      decisions: last?.keyDecisions ?? [],
    });
    // A run after the first that made any non-fold call re-summarized the whole
    // Session, so its decisions are not a fold's.
    if (end > opts.batch) {
      const lost = missingFrom(prior, last?.keyDecisions ?? []);
      if (after.other > before.other) {
        fallbacks++;
        fallbackDroppedExact += lost.exact.length;
        fallbackDroppedLoose += lost.loose.length;
      } else if (after.fold > before.fold) {
        folds++;
        droppedExact += lost.exact.length;
        droppedLoose += lost.loose.length;
      }
    }
    if (cut === observations.length) break;
  }
  const folded = last?.keyDecisions ?? [];
  const missing = missingFrom(full, folded);
  const judged = judging ? await judgeDrift(judging, opts.sessionId, full, steps) : undefined;
  return {
    sessionId: opts.sessionId,
    observations: observations.length,
    full: full.length,
    folded: folded.length,
    folds,
    fallbacks,
    missingExact: missing.exact.length,
    missingLoose: missing.loose.length,
    droppedExact,
    droppedLoose,
    fallbackDroppedExact,
    fallbackDroppedLoose,
    missing: missing.exact,
    steps,
    ...judged,
    fullSummary,
    foldedSummary: last,
  };
}

export const SCREEN_LABELS = ["captured", "never-captured"] as const;
export type ScreenLabel = (typeof SCREEN_LABELS)[number];

export const SCREEN_MODE_TAG = "[screen: one-pass only]";

export interface ScreenResult {
  mode: "screen";
  sessionId: string;
  observations: number;
  full: number;
  labels?: Array<{ decisionId: string; label: ScreenLabel }>;
  fullSummary?: SessionSummary | null;
}

// Screening: only the one-pass summarize. Never-captured here is "the one-pass list
// does not deliver it", a superset of the full run's never-captured (which also needs
// the fold sequence to miss it).
export async function screenOnePass(
  provider: MemoryProvider,
  observations: CompressedObservation[],
  opts: FoldDriftOptions,
  judging?: Judging,
): Promise<ScreenResult> {
  const fullSummary = await summarizer(provider, opts).run(observations);
  const full = fullSummary?.keyDecisions ?? [];
  const labels = judging
    ? await Promise.all(
        judging.key
          .filter((d) => d.sessionId === opts.sessionId)
          .map(async (d) => ({
            decisionId: d.id,
            label: ((await deliveredBy(judging.judge, d, full)) ? "captured" : "never-captured") as ScreenLabel,
          })),
      )
    : undefined;
  return { mode: "screen", sessionId: opts.sessionId, observations: observations.length, full: full.length, labels, fullSummary };
}

function screenCounts(labels: Array<{ label: ScreenLabel }>): string {
  if (labels.length === 0) return "";
  return SCREEN_LABELS.map((l) => ` key:${l}=${labels.filter((x) => x.label === l).length}`).join("");
}

export const screenRow = (r: ScreenResult): string =>
  `${SCREEN_MODE_TAG} ${r.sessionId} obs=${r.observations} full=${r.full}${screenCounts(r.labels ?? [])}`;

export const screenTotal = (results: ScreenResult[]): string =>
  `${SCREEN_MODE_TAG} total sessions=${results.length} full=${results.reduce((n, r) => n + r.full, 0)}${screenCounts(results.flatMap((r) => r.labels ?? []))}`;

// A one-pass decision's judge id is a hash of its text, so a cached verdict is reused only for the same decision.
const textId = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

const deliveredBy = (judge: Judge, decision: Pick<Decision, "id" | "text">, decisions: string[]) =>
  decisions.length > 0 ? judge.delivers(decision, asDecisionList(decisions)) : Promise.resolve(false);

// Judged against the list a reader would be handed, so a paraphrase counts as kept.
async function judgeDrift(
  { judge, key }: Judging,
  sessionId: string,
  full: string[],
  steps: FoldStep[],
): Promise<{ missingJudged: number; labels: Array<{ decisionId: string; label: DecisionLabel }> }> {
  const folded = steps[steps.length - 1]?.decisions ?? [];
  const kept = await Promise.all(
    full.map((text) => deliveredBy(judge, { id: textId(text), text }, folded)),
  );
  const labels: Array<{ decisionId: string; label: DecisionLabel }> = [];
  for (const decision of key.filter((d) => d.sessionId === sessionId)) {
    const inOnePass = await deliveredBy(judge, decision, full);
    const held = await Promise.all(steps.map((s) => deliveredBy(judge, decision, s.decisions)));
    labels.push({ decisionId: decision.id, label: labelFor(held, steps, inOnePass) });
  }
  return { missingJudged: kept.filter((k) => !k).length, labels };
}

// `held[i]`: step i delivers the decision. The loss is charged to the first step that
// had it and then did not. One only the one pass had is charged to the last step, or,
// with no fold to blame (a single step), counted never-captured.
function labelFor(held: boolean[], steps: FoldStep[], inOnePass: boolean): DecisionLabel {
  const last = held.length - 1;
  if (held[last]) return "kept";
  let lostAt = held.findIndex((h, i) => i > 0 && held[i - 1] && !h);
  if (lostAt < 0) {
    if (!inOnePass || last === 0) return "never-captured";
    lostAt = last;
  }
  return steps[lostAt]!.kind === "fallback" ? "dropped-by-fallback" : "dropped-by-fold";
}

// Decisions of `from` that `to` lacks, by normalized exact text and, looser, by
// word-set Jaccard.
function missingFrom(from: string[], to: string[]): { exact: string[]; loose: string[] } {
  const present = new Set(to.map(normalize));
  const exact = from.filter((d) => !present.has(normalize(d)));
  const loose = exact.filter((d) => !to.some((t) => jaccardSimilarity(d, t) >= LOOSE_JACCARD));
  return { exact, loose };
}
