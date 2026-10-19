import type { ISdk } from "../engine/types.js";
import type { MemoryProvider, RawObservation } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import {
  COMPRESSION_BATCH_SYSTEM,
  buildBatchCompressionPrompt,
  buildCompressionPrompt,
} from "../prompts/compression.js";
import { getXmlElementsById } from "../prompts/xml.js";
import {
  checkCompression,
  commitCompression,
  compressionPromptArgs,
  storeDegradedCompression,
  type CompressionJob,
} from "./compress.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { logger } from "../logger.js";

// A reply runs ~300-500 tokens per Observation, so six stay inside the 4096
// MAX_TOKENS default and a reply is not cut short.
export const BATCH_MAX_ITEMS = 6;
// Payload chars across a batch, ~6-8k prompt tokens: with the reply a call
// stays well under 16k tokens. One Observation larger than this goes alone.
export const BATCH_MAX_CHARS = 24_000;
// A Session that pauses this long flushes what it has queued.
export const BATCH_IDLE_MS = 5_000;

// The compressPending reason of an Observation waiting for a batch. A failure
// overwrites it with the failure reason, which leaves the record to
// api::recompress-orphans like any other failed compression.
export const QUEUED = "queued";

interface SessionQueue {
  jobs: CompressionJob[];
  chars: number;
  timer?: ReturnType<typeof setTimeout>;
}

// The raw stays durable in compressPending while it waits, because the
// synthetic record that observe stores alongside it is truncated. A restart
// re-queues it from there (mem::compress-resume).
export async function parkForCompression(kv: StateKV, raw: RawObservation): Promise<void> {
  await kv.set(KV.compressPending, raw.id, {
    observationId: raw.id,
    sessionId: raw.sessionId,
    raw,
    reason: QUEUED,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  });
}

// Compresses each Session's queued Observations several to one LLM call. Every
// queued Observation already has a searchable synthetic record; a batch reply
// overwrites it. An item missing or invalid in the reply goes through
// mem::compress on its own, with that path's retry and degradation.
export function registerCompressBatchFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
): void {
  const queues = new Map<string, SessionQueue>();

  const compressOne = (job: CompressionJob) =>
    sdk.trigger({
      function_id: "mem::compress",
      payload: { observationId: job.observationId, sessionId: job.sessionId, raw: job.raw },
    });

  const compressBatch = async (sessionId: string, queued: CompressionJob[]): Promise<void> => {
    // Evicted or forgotten while it waited: writing it now would resurrect it.
    const jobs: CompressionJob[] = [];
    for (const job of queued) {
      if (await kv.get(KV.observations(sessionId), job.observationId)) jobs.push(job);
      else await kv.delete(KV.compressPending, job.observationId);
    }
    if (jobs.length === 0) return;
    if (jobs.length === 1) {
      await compressOne(jobs[0]);
      return;
    }

    const startMs = Date.now();
    let reply: string;
    try {
      reply = await provider.compress(
        COMPRESSION_BATCH_SYSTEM,
        buildBatchCompressionPrompt(jobs.map((j) => ({ id: j.observationId, ...compressionPromptArgs(j.raw) }))),
      );
    } catch (err) {
      if (metricsStore) await metricsStore.record("mem::compress-batch", Date.now() - startMs, false);
      logger.error("Batch compression failed", {
        sessionId,
        size: jobs.length,
        error: err instanceof Error ? err.message : String(err),
      });
      for (const job of jobs) await storeDegradedCompression(kv, job, "compression_failed");
      return;
    }

    const blocks = getXmlElementsById(reply, "observation");
    const fallback: CompressionJob[] = [];
    for (const job of jobs) {
      const block = blocks.get(job.observationId);
      const verdict = block === undefined ? undefined : checkCompression(block);
      if (!verdict || "errors" in verdict) {
        fallback.push(job);
        continue;
      }
      try {
        await commitCompression(sdk, kv, job, verdict.parsed);
      } catch (err) {
        logger.error("Batch compression commit failed", {
          obsId: job.observationId,
          error: err instanceof Error ? err.message : String(err),
        });
        await storeDegradedCompression(kv, job, "compression_failed");
      }
    }

    const latencyMs = Date.now() - startMs;
    if (metricsStore) {
      await metricsStore.record("mem::compress-batch", latencyMs, fallback.length < jobs.length);
    }
    logger.info("Observation batch compressed", {
      sessionId,
      size: jobs.length,
      compressed: jobs.length - fallback.length,
      fallback: fallback.length,
      latencyMs,
    });
    for (const job of fallback) await compressOne(job);
  };

  const flush = (sessionId: string): Promise<void> => {
    const queue = queues.get(sessionId);
    if (!queue) return Promise.resolve();
    clearTimeout(queue.timer);
    queues.delete(sessionId);
    return compressBatch(sessionId, queue.jobs).catch((err) => {
      logger.error("Batch compression flush failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  // Returns the flush it started, if any, so a caller can await the batch.
  const enqueue = (job: CompressionJob): Promise<void> => {
    // Resume can list an Observation that observe already queued live.
    if (queues.get(job.sessionId)?.jobs.some((j) => j.observationId === job.observationId)) {
      return Promise.resolve();
    }
    const promptChars = buildCompressionPrompt(compressionPromptArgs(job.raw)).length;
    if (promptChars > BATCH_MAX_CHARS) {
      return compressOne(job).then(() => undefined);
    }
    const flushes: Promise<void>[] = [];
    const current = queues.get(job.sessionId);
    if (current && current.chars + promptChars > BATCH_MAX_CHARS) {
      flushes.push(flush(job.sessionId));
    }
    const queue = queues.get(job.sessionId) ?? { jobs: [], chars: 0 };
    queues.set(job.sessionId, queue);
    queue.jobs.push(job);
    queue.chars += promptChars;
    clearTimeout(queue.timer);
    if (queue.jobs.length >= BATCH_MAX_ITEMS) {
      flushes.push(flush(job.sessionId));
    } else {
      queue.timer = setTimeout(() => void flush(job.sessionId), BATCH_IDLE_MS);
      queue.timer.unref?.();
    }
    return Promise.all(flushes).then(() => undefined);
  };

  sdk.registerFunction("mem::compress-enqueue", async (data: CompressionJob) => {
    await enqueue(data);
    return { queued: true };
  });

  sdk.registerFunction("mem::compress-flush", async (data: { sessionId: string }) => {
    await flush(data.sessionId);
    return { flushed: true };
  });

  // Re-queues what a restart left waiting. Failed entries stay with
  // api::recompress-orphans, as they do on the single path.
  sdk.registerFunction("mem::compress-resume", async () => {
    const parked = await kv.list<{ reason?: string; observationId?: string; sessionId?: string; raw?: RawObservation }>(
      KV.compressPending,
    );
    const waiting = parked.filter(
      (p): p is CompressionJob & { reason: string } =>
        p.reason === QUEUED && typeof p.observationId === "string" && typeof p.sessionId === "string" && !!p.raw,
    );
    const sessions = new Set(waiting.map((p) => p.sessionId));
    await Promise.all(waiting.map((p) => enqueue(p)));
    await Promise.all([...sessions].map((s) => flush(s)));
    return { resumed: waiting.length };
  });
}
