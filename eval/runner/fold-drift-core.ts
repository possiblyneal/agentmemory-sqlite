import type { ISdk } from "../../src/engine/types.js";
import type { CompressedObservation, MemoryProvider, Session, SessionSummary } from "../../src/types.js";
import { registerSummarizeFunction } from "../../src/functions/summarize.js";
import { FOLD_SYSTEM } from "../../src/prompts/summary.js";
import { KV } from "../../src/state/schema.js";
import { jaccardSimilarity } from "../../src/state/schema.js";

export interface FoldDriftOptions {
  sessionId: string;
  project: string;
  batch: number;
}

export interface FoldDriftResult {
  sessionId: string;
  observations: number;
  full: number;
  folded: number;
  folds: number;
  missingExact: number;
  missingLoose: number;
  missing: string[];
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
  let folds = 0;
  const counting: MemoryProvider = {
    ...provider,
    summarize: (system, prompt) => {
      if (system === FOLD_SYSTEM) folds++;
      return provider.summarize(system, prompt);
    },
  };
  registerSummarizeFunction(sdk, kv as never, counting);
  const session: Session = { id: opts.sessionId, project: opts.project } as Session;
  return {
    folds: () => folds,
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
): Promise<FoldDriftResult> {
  const full = (await summarizer(provider, opts).run(observations))?.keyDecisions ?? [];

  const sequence = summarizer(provider, opts);
  let last: SessionSummary | null = null;
  for (let end = opts.batch; ; end += opts.batch) {
    const cut = Math.min(end, observations.length);
    last = await sequence.run(observations.slice(0, cut));
    if (cut === observations.length) break;
  }
  const folded = last?.keyDecisions ?? [];

  const exact = new Set(folded.map(normalize));
  const missingList = full.filter((d) => !exact.has(normalize(d)));
  const missingLoose = missingList.filter(
    (d) => !folded.some((f) => jaccardSimilarity(d, f) >= LOOSE_JACCARD),
  );
  return {
    sessionId: opts.sessionId,
    observations: observations.length,
    full: full.length,
    folded: folded.length,
    folds: Math.max(0, sequence.folds()),
    missingExact: missingList.length,
    missingLoose: missingLoose.length,
    missing: missingList,
  };
}
