import type { ISdk } from "../engine/types.js";
import type {
  Session,
  CompressedObservation,
  RawObservation,
  SessionSummary,
  Memory,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { isConsolidationEnabled } from "../config.js";
import { recordAudit } from "./audit.js";
import { deleteIndexed } from "./search.js";
import { unlinkObservationNodes } from "../state/graph-indexes.js";
import { lowerObservationCounts, storeSyntheticCompression } from "./observe.js";
import { logger } from "../logger.js";

interface EvictionConfig {
  staleSessionDays: number;
  lowImportanceMaxDays: number;
  lowImportanceThreshold: number;
  maxObservationsPerProject: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULTS: EvictionConfig = {
  staleSessionDays: 30,
  lowImportanceMaxDays: 90,
  lowImportanceThreshold: 3,
  maxObservationsPerProject: 10_000,
};

interface EvictionStats {
  staleSessions: number;
  lowImportanceObs: number;
  capEvictions: number;
  expiredMemories: number;
  nonLatestMemories: number;
  dryRun: boolean;
}

function isValidRecoveryResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  if (!("success" in result)) return true;
  return (result as { success?: unknown }).success !== false;
}

function isCompressedObservation(
  observation: CompressedObservation | RawObservation,
): observation is CompressedObservation {
  return (
    "title" in observation &&
    typeof observation.title === "string" &&
    observation.title.length > 0
  );
}

async function recoverStaleSession(
  sdk: ISdk,
  sessionId: string,
): Promise<boolean> {
  try {
    const result = await sdk.trigger({
      function_id: "event::session::stopped",
      // Recovery holds one LLM slot and suppresses the per-session
      // consolidation fan-out: eviction runs a single corpus-wide
      // consolidation pass after all recoveries instead.
      payload: { sessionId, recovery: true },
    });
    if (!isValidRecoveryResult(result)) {
      logger.warn("Stale session recovery failed", {
        sessionId,
        result,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn("Stale session recovery failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function runRecoveredSessionConsolidation(sdk: ISdk): Promise<void> {
  // Same gate as the session-stop path: keyless installs must not fire
  // no-op LLM consolidation from an eviction sweep either.
  if (!isConsolidationEnabled()) return;
  try {
    await sdk.trigger({
      function_id: "mem::consolidate-pipeline",
      payload: { tier: "all", force: true },
    });
    // One crystallization pass for the batch (the per-session fan-out was
    // suppressed on the recovery path), keeping recovered sessions
    // consistent with normally-stopped ones without the N-fold amplification.
    await sdk.trigger({
      function_id: "mem::auto-crystallize",
      payload: { olderThanDays: 0 },
    });
  } catch (err) {
    logger.warn("Recovered session consolidation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function recoverOrEvictStaleSession(
  sdk: ISdk,
  kv: StateKV,
  sessionId: string,
): Promise<{ recovered: boolean; evicted: boolean }> {
  const kept = { recovered: false, evicted: false };
  const observations = await kv
    .list<CompressedObservation | RawObservation>(KV.observations(sessionId))
    .catch((err) => {
      logger.warn("Stale session observation scan failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
  if (!observations) return kept;

  // A raw row this old is a compression that never ran, so it is
  // compressed synthetically here; otherwise the Session could
  // never be summarized and would be retried on every run.
  let recovered = false;
  if (observations.length > 0) {
    const raw = observations.filter(
      (o): o is RawObservation => !isCompressedObservation(o),
    );
    try {
      for (const o of raw) {
        await storeSyntheticCompression(kv, { ...o, sessionId });
      }
    } catch (err) {
      logger.warn("Stale session compression failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return kept;
    }
    recovered = await recoverStaleSession(sdk, sessionId);
    if (!recovered) return kept;
  }

  try {
    await kv.delete(KV.sessions, sessionId);
  } catch (err) {
    logger.warn("Eviction delete failed", {
      resource: "session",
      id: sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { recovered, evicted: false };
  }
  await recordAudit(kv, "delete", "mem::evict", [sessionId], {
    resource: "session",
    reason: recovered
      ? "stale_session_recovered_then_evicted"
      : "stale_session_without_summary",
    dryRun: false,
  });
  return { recovered, evicted: true };
}

export function registerEvictFunction(sdk: ISdk, kv: StateKV): void {
  let recoveryRunning = false;
  sdk.registerFunction("mem::evict", 
    async (data: { dryRun?: boolean }): Promise<EvictionStats> => {
      const dryRun = data?.dryRun ?? false;
      const { decrementImageRef } = await import("./image-refs.js");

      const configOverride = await kv
        .get<Partial<EvictionConfig>>(KV.config, "eviction")
        .catch(() => null);
      const cfg = { ...DEFAULTS, ...configOverride };

      const now = Date.now();
      const stats: EvictionStats = {
        staleSessions: 0,
        lowImportanceObs: 0,
        capEvictions: 0,
        expiredMemories: 0,
        nonLatestMemories: 0,
        dryRun,
      };

      const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
      const summaries = await kv
        .list<SessionSummary>(KV.summaries)
        .catch(() => []);
      const summaryIds = new Set(summaries.map((s) => s.sessionId));

      const staleMs = cfg.staleSessionDays * MS_PER_DAY;
      const staleSessions = sessions.filter(
        (session) =>
          session.startedAt &&
          now - new Date(session.startedAt).getTime() > staleMs &&
          !summaryIds.has(session.id),
      );
      // One recovery sweep at a time, so the sweep's one-LLM-slot bound holds
      // when a second eviction is triggered while the first is still running.
      // A second sweep skips rather than queuing behind a keyed lock: it would
      // mostly repeat the running sweep's Sessions, and the next sweep finds
      // any that went stale since.
      if (dryRun) {
        stats.staleSessions = staleSessions.length;
      } else if (recoveryRunning) {
        logger.info("Stale-Session recovery already running; this sweep skips it", {
          staleSessions: staleSessions.length,
        });
      } else {
        recoveryRunning = true;
        try {
          let recoveredStaleSessions = 0;
          for (const session of staleSessions) {
            const { recovered, evicted } = await recoverOrEvictStaleSession(
              sdk,
              kv,
              session.id,
            );
            if (recovered) recoveredStaleSessions++;
            if (evicted) stats.staleSessions++;
          }
          if (recoveredStaleSessions > 0) {
            await runRecoveredSessionConsolidation(sdk);
          }
        } finally {
          recoveryRunning = false;
        }
      }

      const removedBySession = new Map<string, number>();
      const countRemoval = (sessionId: string) =>
        removedBySession.set(sessionId, (removedBySession.get(sessionId) ?? 0) + 1);
      const projectObs = new Map<string, CompressedObservation[]>();
      for (const session of sessions) {
        const obs = await kv
          .list<CompressedObservation>(KV.observations(session.id))
          .catch(() => []);
        const compressed = obs.filter((o) => o.title);
        const lowImportanceIds = new Set<string>();

        for (const o of compressed) {
          if (!o.timestamp) continue;
          const age = now - new Date(o.timestamp).getTime();
          const maxAge = cfg.lowImportanceMaxDays * MS_PER_DAY;
          if (
            age > maxAge &&
            (o.importance ?? 5) < cfg.lowImportanceThreshold
          ) {
            if (dryRun) {
              stats.lowImportanceObs++;
              lowImportanceIds.add(o.id);
            } else {
              try {
                await deleteIndexed(kv, KV.observations(session.id), o.id);
                stats.lowImportanceObs++;
                lowImportanceIds.add(o.id);
                countRemoval(session.id);
                await unlinkObservationNodes(kv, o.id);
              } catch (err) {
                logger.warn("Eviction delete failed", {
                  resource: "observation",
                  id: o.id,
                  sessionId: session.id,
                  error: err instanceof Error ? err.message : String(err),
                });
                continue;
              }
              if (o.imageData) await decrementImageRef(kv, sdk, o.imageData);
              if (o.imageRef && o.imageRef !== o.imageData) await decrementImageRef(kv, sdk, o.imageRef);
              await recordAudit(kv, "delete", "mem::evict", [o.id], {
                resource: "observation",
                reason: "low_importance_old_observation",
                sessionId: session.id,
                dryRun,
              });
            }
          }
        }

        const project = session.project || "unknown";
        const existing = projectObs.get(project) || [];
        existing.push(...compressed.filter((o) => !lowImportanceIds.has(o.id)));
        projectObs.set(project, existing);
      }

      for (const [, obs] of projectObs) {
        if (obs.length > cfg.maxObservationsPerProject) {
          const sorted = obs.sort(
            (a, b) => (a.importance ?? 5) - (b.importance ?? 5),
          );
          const toEvict = sorted.slice(
            0,
            obs.length - cfg.maxObservationsPerProject,
          );
          if (dryRun) {
            stats.capEvictions += toEvict.length;
          } else {
            for (const o of toEvict) {
              try {
                await deleteIndexed(kv, KV.observations(o.sessionId), o.id);
                stats.capEvictions++;
                countRemoval(o.sessionId);
                await unlinkObservationNodes(kv, o.id);
              } catch (err) {
                logger.warn("Eviction delete failed", {
                  resource: "observation",
                  id: o.id,
                  sessionId: o.sessionId,
                  error: err instanceof Error ? err.message : String(err),
                });
                continue;
              }
              if (o.imageData) await decrementImageRef(kv, sdk, o.imageData);
              if (o.imageRef && o.imageRef !== o.imageData) await decrementImageRef(kv, sdk, o.imageRef);
              await recordAudit(kv, "delete", "mem::evict", [o.id], {
                resource: "observation",
                reason: "project_observation_cap",
                sessionId: o.sessionId,
                dryRun,
              });
            }
          }
        }
      }

      await lowerObservationCounts(kv, removedBySession);

      const memories = await kv.list<Memory>(KV.memories).catch(() => []);
      const evictedMemIds = new Set<string>();
      for (const mem of memories) {
        if (mem.forgetAfter) {
          const expiry = new Date(mem.forgetAfter).getTime();
          if (now > expiry) {
            if (dryRun) {
              stats.expiredMemories++;
              evictedMemIds.add(mem.id);
            } else {
              try {
                await deleteIndexed(kv, KV.memories, mem.id);
                stats.expiredMemories++;
                evictedMemIds.add(mem.id);
              } catch (err) {
                logger.warn("Eviction delete failed", {
                  resource: "memory",
                  id: mem.id,
                  reason: "expired_memory",
                  error: err instanceof Error ? err.message : String(err),
                });
                continue;
              }
              if (mem.imageRef) {
                await decrementImageRef(kv, sdk, mem.imageRef);
              }
              await recordAudit(kv, "delete", "mem::evict", [mem.id], {
                resource: "memory",
                reason: "expired_memory",
                dryRun,
              });
            }
          }
        }

        if (
          !evictedMemIds.has(mem.id) &&
          mem.isLatest === false &&
          mem.createdAt
        ) {
          const age = now - new Date(mem.createdAt).getTime();
          if (age > cfg.lowImportanceMaxDays * MS_PER_DAY) {
            if (dryRun) {
              stats.nonLatestMemories++;
            } else {
              try {
                await deleteIndexed(kv, KV.memories, mem.id);
                stats.nonLatestMemories++;
              } catch (err) {
                logger.warn("Eviction delete failed", {
                  resource: "memory",
                  id: mem.id,
                  reason: "old_non_latest_memory",
                  error: err instanceof Error ? err.message : String(err),
                });
                continue;
              }
              if (mem.imageRef) {
                await decrementImageRef(kv, sdk, mem.imageRef);
              }
              await recordAudit(kv, "delete", "mem::evict", [mem.id], {
                resource: "memory",
                reason: "old_non_latest_memory",
                dryRun,
              });
            }
          }
        }
      }

      logger.info("Eviction complete", { stats });
      return stats;
    },
  );
}
