import type { ISdk } from "../engine/types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Session } from "../types.js";
import { isAutoCompressEnabled } from "../config.js";
import { logger } from "../logger.js";
import { QUEUED } from "./compress-batch.js";

const GRACE_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const DEFAULT_LIMIT = 50;

type RecompressOptions = {
  limit?: number;
  dryRun?: boolean;
  requeueQuarantined?: boolean;
  graceBypassBefore?: string;
};

// Re-run compression for observations that a failed mem::compress left in
// raw shape - present in KV but in neither search index, so unretrievable.
// Two sources: mem:compress-pending (parked by the failure path, full raw
// preserved) and raw-shaped records in KV.observations (the historical
// orphans that predate that fix). Sequential and limit-bounded on purpose:
// firing hundreds of concurrent LLM calls at a provider that has just stopped
// returning 529s is how you cause the next outage.
export function registerRecompressOrphansFunction(sdk: ISdk, kv: StateKV): void {
  // Two overlapping passes pick the same targets: each Observation is
  // compressed twice and a failure counts two attempts toward quarantine.
  let running = false;
  sdk.registerFunction("mem::recompress-orphans", async (data: RecompressOptions | undefined) => {
    const body = data ?? {};
    const dryRun = body.dryRun === true;
    if (dryRun) return recompressOrphans(sdk, kv, body);
    if (running) return { success: false, running: true, error: "a recompress pass is already running" };
    running = true;
    try {
      return await recompressOrphans(sdk, kv, body);
    } finally {
      running = false;
    }
  });
}

async function recompressOrphans(sdk: ISdk, kv: StateKV, body: RecompressOptions) {
  const limit = Math.max(1, Math.min(1000, Number(body.limit) || DEFAULT_LIMIT));
  const dryRun = body.dryRun === true;
  // Records captured before this instant skip the one-hour grace. The
  // cutover passes its freeze timestamp: nothing captured before the
  // freeze can still have a compression in flight on the new daemon.
  const graceBypassBefore =
    typeof body.graceBypassBefore === "string" ? new Date(body.graceBypassBefore).getTime() : NaN;
  // Give quarantined entries (attempts >= MAX_ATTEMPTS) one more shot.
  // Meant for after a compression-pipeline fix lands: what was a
  // deterministic failure may compress cleanly under the new code.
  const requeueQuarantined = body.requeueQuarantined === true;
  const now = Date.now();

  const targets: Array<{ observationId: string; sessionId: string; raw: unknown }> = [];

  // Raw-shaped orphans FIRST: they are the records no search can return,
  // so the batch budget belongs to them. Parked entries are already
  // findable as degraded synthetics - re-compressing them is a quality
  // upgrade, not a rescue. (The first version of this sweep did the
  // opposite and starved the raw ones: every failed parked entry was
  // re-parked, so the pending queue never shrank and always ate the
  // whole budget.)
  let rawOrphans = 0;
  for (const session of await kv.list<Session>(KV.sessions)) {
    const sid = session?.id;
    if (typeof sid !== "string" || sid.length === 0) continue;
    for (const o of await kv.list<Record<string, unknown>>(KV.observations(sid))) {
      const oid = o?.["id"];
      if (typeof oid !== "string") continue;
      if (typeof o["narrative"] === "string") continue;
      if (typeof o["hookType"] !== "string") continue;
      const ts = new Date(String(o["timestamp"])).getTime();
      const bypass = Number.isFinite(graceBypassBefore) && Number.isFinite(ts) && ts < graceBypassBefore;
      if (Number.isFinite(ts) && now - ts < GRACE_MS && !bypass) continue;
      rawOrphans++;
      if (targets.length < limit) {
        targets.push({ observationId: oid, sessionId: sid, raw: o });
      }
    }
  }

  const queued = new Set(targets.map((t) => t.observationId));
  let parked = 0;
  let quarantined = 0;
  for (const p of await kv.list<{
    observationId?: string;
    sessionId?: string;
    raw?: unknown;
    attempts?: number;
    reason?: string;
    queuedAt?: string;
  }>(KV.compressPending)) {
    if (typeof p?.observationId !== "string" || typeof p?.sessionId !== "string") continue;
    if (queued.has(p.observationId)) continue;
    // A batch entry inside the grace is still queued or in flight; past it,
    // the batch lost it and the sweep takes over.
    if (p.reason === QUEUED) {
      const ts = new Date(String(p.queuedAt)).getTime();
      const bypass = Number.isFinite(graceBypassBefore) && Number.isFinite(ts) && ts < graceBypassBefore;
      if (Number.isFinite(ts) && now - ts < GRACE_MS && !bypass) continue;
    }
    // Evicted or forgotten while parked: compressing it now would resurrect it.
    if (!(await kv.get(KV.observations(p.sessionId), p.observationId))) {
      if (!dryRun) await kv.delete(KV.compressPending, p.observationId);
      continue;
    }
    if ((p.attempts ?? 0) >= MAX_ATTEMPTS) {
      quarantined++;
      if (!requeueQuarantined) continue;
    } else {
      parked++;
    }
    if (targets.length < limit) {
      targets.push({ observationId: p.observationId, sessionId: p.sessionId, raw: p.raw });
    }
  }

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      rawOrphans,
      parked,
      quarantined,
      queued: targets.length,
      limit,
    };
  }

  let recompressed = 0;
  let stillFailing = 0;
  for (const t of targets) {
    try {
      const result = (await sdk.trigger({
        function_id: "mem::compress",
        payload: t,
      })) as { success?: boolean } | null;
      if (result?.success) recompressed++;
      else stillFailing++;
    } catch {
      stillFailing++;
    }
    // Bail out rather than grind through hundreds of doomed calls when
    // the provider is clearly still down. Not for requeueQuarantined
    // batches: there every target is a known deterministic failure, so
    // ten straight losses say nothing about the provider.
    if (!requeueQuarantined && stillFailing >= 10 && recompressed === 0) {
      logger.warn("recompress-orphans aborting: provider still failing", {
        attempted: recompressed + stillFailing,
      });
      break;
    }
  }

  logger.info("recompress-orphans finished", {
    rawOrphans,
    parked,
    quarantined,
    queued: targets.length,
    recompressed,
    stillFailing,
  });
  return {
    success: true,
    rawOrphans,
    parked,
    quarantined,
    queued: targets.length,
    recompressed,
    stillFailing,
  };
}

export function createRecompressSweep(sdk: ISdk): () => Promise<void> {
  return async () => {
    if (!isAutoCompressEnabled()) return;
    try {
      await sdk.trigger({ function_id: "mem::recompress-orphans", payload: {} });
    } catch (err) {
      logger.error("Hourly recompress-orphans pass failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
