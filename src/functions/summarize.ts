import type { ISdk } from "../engine/types.js";
import type {
  CompressedObservation,
  SessionSummary,
  MemoryProvider,
  Session,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import {
  SUMMARY_SYSTEM,
  buildSummaryPrompt,
  renderSummaryObservation,
  REDUCE_SYSTEM,
  buildReducePrompt,
} from "../prompts/summary.js";
import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { SummaryOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";
import { scoreSummary } from "../eval/quality.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { safeAudit } from "./audit.js";
import { isNoopProvider } from "../providers/noop.js";
import { logger } from "../logger.js";

// Per-chunk prompt budget in tokens when a Session is too large to fit in
// one LLM call. Measured on the Operator's broker: a 50k-token chunk
// summarizes cold in 60–89s solo. Override via SUMMARIZE_CHUNK_TOKENS.
const CHUNK_TOKENS_DEFAULT = 50_000;
// Tokens the system prompt and chat template add on top of the rendered
// Observations, measured on the Operator's broker.
const PROMPT_OVERHEAD_TOKENS = 400;
// Tokens buildSummaryPrompt spends joining one Observation to the next.
const SEPARATOR_TOKENS = 4;
// Concurrent in-flight chunk calls. The Operator's broker serialises chunks
// on one GPU, and AGENTMEMORY_LLM_TIMEOUT_MS was measured at 2 — raise
// SUMMARIZE_CHUNK_CONCURRENCY only with the timeout re-measured.
const CHUNK_CONCURRENCY_DEFAULT = 2;
// Parallel tokenize calls while measuring a Session's Observations.
const COUNT_CONCURRENCY = 16;
// Bail on the merged summary if more than this fraction of chunks fail
// to parse — a half-blind narrative is worse than a clean error.
const MAX_SKIP_RATIO = 0.5;

// A budget at or below the prompt overhead leaves no room for any
// Observation, so it is floored to one payload token.
function getChunkTokens(): number {
  const raw = process.env.SUMMARIZE_CHUNK_TOKENS;
  if (!raw) return CHUNK_TOKENS_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return CHUNK_TOKENS_DEFAULT;
  return Math.max(n, PROMPT_OVERHEAD_TOKENS + 1);
}

function getChunkConcurrency(): number {
  const raw = process.env.SUMMARIZE_CHUNK_CONCURRENCY;
  if (!raw) return CHUNK_CONCURRENCY_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHUNK_CONCURRENCY_DEFAULT;
}

// The estimate idiom this tree already uses; it overcounts measured
// content by ~17%, the safe direction for a budget.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  for (let start = 0; start < items.length; start += concurrency) {
    const batch = items.slice(start, start + concurrency);
    const results = await Promise.all(batch.map(fn));
    results.forEach((r, j) => {
      out[start + j] = r;
    });
  }
  return out;
}

function fitsOneChunk(counts: number[], budget: number): boolean {
  const payload = counts.reduce((sum, n) => sum + n + SEPARATOR_TOKENS, 0);
  return payload <= budget - PROMPT_OVERHEAD_TOKENS;
}

// The estimate overcounts, so a Session it already fits in one chunk needs no
// measuring: on a broker that queues tokenize behind generation, one request
// per Observation is load the summary itself has to wait behind.
async function countObservationTokens(
  provider: MemoryProvider,
  texts: string[],
  budget: number,
  sessionId: string,
): Promise<number[]> {
  const estimates = texts.map(estimateTokens);
  if (fitsOneChunk(estimates, budget)) return estimates;
  if (provider.countTokens) {
    try {
      return await mapWithConcurrency(texts, COUNT_CONCURRENCY, (t) =>
        provider.countTokens!(t),
      );
    } catch (err) {
      logger.warn("Token count failed, packing chunks by estimate", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return estimates;
}

// Greedy in-order packing. An Observation that alone exceeds the budget
// becomes its own chunk: dropping it would lose Session history, and the
// provider's own context error is the right failure for that chunk.
function packChunks(
  compressed: CompressedObservation[],
  counts: number[],
  budget: number,
  sessionId: string,
): CompressedObservation[][] {
  const payloadBudget = budget - PROMPT_OVERHEAD_TOKENS;
  const chunks: CompressedObservation[][] = [];
  let current: CompressedObservation[] = [];
  let used = 0;
  compressed.forEach((obs, i) => {
    const tokens = (counts[i] ?? 0) + SEPARATOR_TOKENS;
    if (current.length > 0 && used + tokens > payloadBudget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    if (tokens > payloadBudget) {
      logger.warn("Observation exceeds the chunk budget on its own", {
        sessionId,
        observationId: obs.id,
        tokens,
        budget,
      });
    }
    current.push(obs);
    used += tokens;
  });
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// One chunk call with retry-once. Returns null when both attempts fail —
// whether by parse failure, provider 4xx (content rejected by upstream
// filters), or transient network/5xx errors that didn't recover on retry.
// All failure modes are equivalent at this layer: the chunk is unusable,
// skip it and let the caller decide via the skip-ratio bailout whether
// the overall summary is still trustworthy. Errors that affect every
// chunk (auth, model down) will trip the bailout naturally.
async function summarizeChunkWithRetry(
  provider: MemoryProvider,
  chunk: CompressedObservation[],
  sessionId: string,
  project: string,
  idx: number,
  total: number,
): Promise<SessionSummary | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const xml = await provider.summarize(
        SUMMARY_SYSTEM,
        buildSummaryPrompt(chunk),
      );
      const parsed = parseSummaryXml(xml, sessionId, project, chunk.length);
      if (parsed) return parsed;
      logger.warn("Summarize chunk parse failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
      });
    } catch (err) {
      logger.warn("Summarize chunk LLM call failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}

// Measures every Observation once and packs them against the chunk budget.
async function planChunks(
  provider: MemoryProvider,
  compressed: CompressedObservation[],
  sessionId: string,
): Promise<CompressedObservation[][]> {
  const budget = getChunkTokens();
  const texts = compressed.map(renderSummaryObservation);
  const counts = await countObservationTokens(provider, texts, budget, sessionId);
  const chunks = packChunks(compressed, counts, budget, sessionId);
  if (chunks.length > 1) {
    logger.info("Summarize chunking session", {
      sessionId,
      chunks: chunks.length,
      budget,
      concurrency: getChunkConcurrency(),
      totalObservations: compressed.length,
    });
  }
  return chunks;
}

// Returns the final summary XML string. A single chunk is one LLM call.
// Several are processed in parallel batches, each chunk retried once on
// parse failure, persistently-bad chunks skipped, and the remaining
// partials merged via a reduce call.
async function produceSummaryXml(
  provider: MemoryProvider,
  chunks: CompressedObservation[][],
  sessionId: string,
  project: string,
): Promise<{
  response: string;
  mode: "single" | "chunked";
  chunks: number;
  skipped?: number;
}> {
  if (chunks.length === 1) {
    const response = await provider.summarize(
      SUMMARY_SYSTEM,
      buildSummaryPrompt(chunks[0]!),
    );
    return { response, mode: "single", chunks: 1 };
  }

  // Results keep chunk order, so the reduce step sees partials in
  // chronological order even when some were skipped.
  const partialByIdx = await mapWithConcurrency(
    chunks.map((chunk, idx) => ({ chunk, idx })),
    getChunkConcurrency(),
    ({ chunk, idx }) =>
      summarizeChunkWithRetry(provider, chunk, sessionId, project, idx, chunks.length),
  );

  const skipped = partialByIdx.filter((p) => p === null).length;
  const partials = partialByIdx.filter((p): p is SessionSummary => p !== null);

  if (skipped > Math.floor(chunks.length * MAX_SKIP_RATIO)) {
    throw new Error(
      `too_many_chunks_skipped: ${skipped}/${chunks.length} chunks failed to parse after retry`,
    );
  }
  if (skipped > 0) {
    logger.warn("Summarize chunks partially skipped", {
      sessionId,
      skipped,
      total: chunks.length,
    });
  }

  const chunkStarts: number[] = [];
  for (let offset = 0, i = 0; i < chunks.length; i++) {
    chunkStarts.push(offset);
    offset += chunks[i]!.length;
  }
  const reduceInput = partials.map((p) => {
    const originalIdx = partialByIdx.indexOf(p);
    const start = chunkStarts[originalIdx] ?? 0;
    return {
      title: p.title,
      narrative: p.narrative,
      keyDecisions: p.keyDecisions,
      filesModified: p.filesModified,
      concepts: p.concepts,
      obsRangeStart: start + 1,
      obsRangeEnd: start + chunks[originalIdx]!.length,
    };
  });
  const response = await provider.summarize(
    REDUCE_SYSTEM,
    buildReducePrompt(reduceInput),
  );
  return { response, mode: "chunked", chunks: chunks.length, skipped };
}

// #783: many LLMs (DeepSeek, GPT variants, some Anthropic responses)
// wrap structured XML in markdown code fences or add conversational
// text before/after. Strip those wrappers before the tag regex so a
// well-formed summary doesn't get silently dropped as parse_failed.
function stripXmlWrappers(raw: string): string {
  if (!raw) return "";
  let cleaned = raw.trim();
  // ```xml ... ``` or ``` ... ``` fences (anywhere in the payload).
  cleaned = cleaned.replace(/```\s*xml\s*\n?/gi, "");
  cleaned = cleaned.replace(/```/g, "");
  cleaned = cleaned.trim();
  // If preamble / postamble surrounds the XML root, peel it off.
  const rootMatch = cleaned.match(
    /(<[a-zA-Z_][a-zA-Z0-9_-]*>[\s\S]*<\/[a-zA-Z_][a-zA-Z0-9_-]*>)/,
  );
  if (rootMatch && rootMatch[1]) return rootMatch[1].trim();
  return cleaned;
}

function parseSummaryXml(
  xml: string,
  sessionId: string,
  project: string,
  obsCount: number,
): SessionSummary | null {
  const cleaned = stripXmlWrappers(xml);
  const title = getXmlTag(cleaned, "title");
  if (!title) return null;

  return {
    sessionId,
    project,
    createdAt: new Date().toISOString(),
    title,
    narrative: getXmlTag(cleaned, "narrative"),
    keyDecisions: getXmlChildren(cleaned, "decisions", "decision"),
    filesModified: getXmlChildren(cleaned, "files", "file"),
    concepts: getXmlChildren(cleaned, "concepts", "concept"),
    observationCount: obsCount,
  };
}

export function registerSummarizeFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
): void {
  sdk.registerFunction("mem::summarize", 
    async (data: { sessionId: string; force?: boolean } | undefined) => {
      const startMs = Date.now();
      if (!data || typeof data.sessionId !== "string" || !data.sessionId.trim()) {
        return { success: false, error: "sessionId is required" };
      }
      const sessionId = data.sessionId.trim();

      const session = await kv.get<Session>(KV.sessions, sessionId);
      if (!session) {
        logger.warn("Session not found for summarize", {
          sessionId,
        });
        return { success: false, error: "session_not_found" };
      }

      const observations = await kv.list<CompressedObservation>(
        KV.observations(sessionId),
      );
      const compressed = observations.filter((o) => o.title);

      if (compressed.length === 0) {
        logger.info("No observations to summarize", {
          sessionId,
        });
        return { success: false, error: "no_observations" };
      }

      // A stored summary is current when both the Observation count and the
      // last Observation id still match: a delete followed by a new
      // Observation keeps the count but moves the id.
      const lastObservationId = compressed[compressed.length - 1]!.id;
      if (!data.force) {
        const existing = await kv.get<SessionSummary>(KV.summaries, sessionId);
        if (
          existing &&
          existing.observationCount === compressed.length &&
          existing.lastObservationId === lastObservationId
        ) {
          logger.info("Session Summary current, reused", {
            sessionId,
            observationCount: compressed.length,
          });
          return { success: true, summary: existing, reused: true };
        }
      }

      if (isNoopProvider(provider)) {
        logger.info("Summarize skipped — no LLM provider configured", {
          sessionId,
        });
        return {
          success: false,
          error: "no_provider",
          reason:
            "No LLM provider key set; Summarize is a no-op. Set ANTHROPIC_API_KEY (or GEMINI/OPENROUTER/MINIMAX) in ~/.agentmemory/.env to enable.",
        };
      }

      try {
        // #783: chunk-level produceSummaryXml retries internally, but
        // the final merge used to parse once and bail. Wrap the
        // produce-and-parse pair in the same 2-attempt loop so a
        // markdown-wrapped or otherwise wrapped response gets a
        // second roll-of-the-dice instead of dropping the summary.
        let summary: SessionSummary | null = null;
        let response = "";
        let mode = "single";
        let chunks = 1;
        const planned = await planChunks(provider, compressed, sessionId);
        for (let attempt = 1; attempt <= 2; attempt++) {
          const produced = await produceSummaryXml(
            provider,
            planned,
            sessionId,
            session.project,
          );
          response = produced.response;
          mode = produced.mode;
          chunks = produced.chunks;
          if (!response || !response.trim()) {
            logger.warn("Empty provider response on summarize", {
              sessionId,
              provider: provider.name,
              mode,
              chunks,
              observationCount: compressed.length,
              attempt,
            });
            continue;
          }
          summary = parseSummaryXml(
            response,
            sessionId,
            session.project,
            compressed.length,
          );
          if (summary) {
            summary.lastObservationId = lastObservationId;
            break;
          }
          logger.warn("Failed to parse summary XML", { sessionId, attempt });
        }

        if (!response || !response.trim()) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          return { success: false, error: "empty_provider_response" };
        }

        if (!summary) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          return { success: false, error: "parse_failed" };
        }

        const summaryForValidation = {
          title: summary.title,
          narrative: summary.narrative,
          keyDecisions: summary.keyDecisions,
          filesModified: summary.filesModified,
          concepts: summary.concepts,
        };
        const validation = validateOutput(
          SummaryOutputSchema,
          summaryForValidation,
          "mem::summarize",
        );

        if (!validation.valid) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          logger.warn("Summary validation failed", {
            sessionId,
            errors: validation.result.errors,
          });
          return { success: false, error: "validation_failed" };
        }

        const qualityScore = scoreSummary(summaryForValidation);

        await kv.set(KV.summaries, sessionId, summary);
        await safeAudit(kv, "compress", "mem::summarize", [sessionId], {
          title: summary.title,
          observationCount: compressed.length,
        });

        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record(
            "mem::summarize",
            latencyMs,
            true,
            qualityScore,
          );
        }

        logger.info("Session summarized", {
          sessionId,
          title: summary.title,
          decisions: summary.keyDecisions.length,
          qualityScore,
          valid: validation.valid,
        });

        return { success: true, summary, qualityScore };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record("mem::summarize", latencyMs, false);
        }
        logger.error("Summarize failed", {
          sessionId,
          error: msg,
        });
        return { success: false, error: msg };
      }
    },
  );
}
