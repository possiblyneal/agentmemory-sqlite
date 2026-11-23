import { deleteWithFacets } from "./facets.js";
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
import { withKeyedLock } from "../state/keyed-mutex.js";
import { MEMORY_WRITE_LOCK } from "../state/memory-utils.js";
import { isConsolidationEnabled, isGraphExtractionEnabled } from "../config.js";
import { graphLegDisabled } from "../state/graph-indexes.js";
import { recordAudit } from "./audit.js";
import { deleteIndexed } from "./search.js";
import { evictGraphForSources } from "./graph-eviction.js";
import { lowerObservationCounts, storeSyntheticCompression } from "./observe.js";
import { isAwaitingCompression } from "./compress-synthetic.js";
import { summaryCovers } from "./summarize.js";
import { logger } from "../logger.js";

interface EvictionConfig {
  staleSessionDays: number;
  lowImportanceMaxDays: number;
  lowImportanceThreshold: number;
  nonLatestMemoryMaxDays: number;
  maxObservationsPerProject: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULTS: EvictionConfig = {
  staleSessionDays: 30,
  lowImportanceMaxDays: 1,
  lowImportanceThreshold: 5,
  nonLatestMemoryMaxDays: 90,
  maxObservationsPerProject: 10_000,
};

interface EvictionStats {
  staleSessions: number;
  lowImportanceObs: number;
  capEvictions: number;
  expiredMemories: number;
  nonLatestMemories: number;
  graphNodes: number;
  graphEdges: number;
  dryRun: boolean;
}

function isValidRecoveryResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  if (!("success" in result)) return true;
  return (result as { success?: unknown }).success !== false;
}

function isStopFinishedWith(
  o: CompressedObservation,
  session: Session,
  summary: SessionSummary | undefined,
): boolean {
  if (!summary) return false;
  if (!summaryCovers(summary, o.timestamp)) return false;
  if (!isGraphExtractionEnabled() || graphLegDisabled()) return true;
  return !!session.graphExtractedThrough && o.timestamp <= session.graphExtractedThrough;
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
  prior: SessionSummary | undefined,
  dryRun: boolean,
  scannedSessions: Set<string>,
): Promise<{ recovered: boolean; evicted: boolean; summary?: SessionSummary }> {
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
  scannedSessions.add(sessionId);
  if (prior && !observations.some((o) =>
    !isCompressedObservation(o) || isAwaitingCompression(o) || !summaryCovers(prior, o.timestamp)
  )) return kept;
  if (dryRun) return { recovered: false, evicted: observations.length === 0 };

  // A raw row this old is a compression that never ran, so it is
  // compressed synthetically here; otherwise the Session could
  // never be summarized and would be retried on every run.
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
    if (!(await recoverStaleSession(sdk, sessionId))) return kept;
    const summary = await kv.get<SessionSummary>(KV.summaries, sessionId).catch(() => null);
    if (!summary) return kept;
    return {
      recovered: observations.every((o) => summaryCovers(summary, o.timestamp)),
      evicted: false,
      summary,
    };
  }

  try {
    const deleted = await withKeyedLock(`obs:${sessionId}`, async () => {
      const current = await kv.listPage(KV.observations(sessionId), undefined, 1);
      if (current.length > 0) return false;
      await kv.delete(KV.sessions, sessionId);
      return true;
    });
    if (!deleted) return kept;
  } catch (err) {
    logger.warn("Eviction delete failed", {
      resource: "session",
      id: sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return kept;
  }
  await recordAudit(kv, "delete", "mem::evict", [sessionId], {
    resource: "session",
    reason: "stale_session_without_summary",
    dryRun: false,
  });
  return { recovered: false, evicted: true };
}

export function registerEvictFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::evict", (data: { dryRun?: boolean }) =>
    withKeyedLock("mem::evict", async (): Promise<EvictionStats> => {
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
        graphNodes: 0,
        graphEdges: 0,
        dryRun,
      };

      const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
      const summaries = await kv
        .list<SessionSummary>(KV.summaries)
        .catch(() => []);
      const summaryBySession = new Map(summaries.map((s) => [s.sessionId, s]));

      const staleMs = cfg.staleSessionDays * MS_PER_DAY;
      const scannedSessions = new Set<string>();
      const scannedStaleCandidates = new Set<string>();
      let recoveredStaleSessions = 0;
      for (const session of sessions) {
        if (!(now - new Date(session.startedAt).getTime() > staleMs)) continue;
        const prior = summaryBySession.get(session.id);
        if (prior && !prior.coveredThrough) continue;
        scannedStaleCandidates.add(session.id);
        const { recovered, evicted, summary } = await recoverOrEvictStaleSession(
          sdk, kv, session.id, prior, dryRun, scannedSessions,
        );
        if (summary) summaryBySession.set(session.id, summary);
        if (recovered) recoveredStaleSessions++;
        if (evicted) stats.staleSessions++;
      }
      if (recoveredStaleSessions > 0) await runRecoveredSessionConsolidation(sdk);

      const evictedSourceIds: string[] = [];
      const removedBySession = new Map<string, number>();
      const countRemoval = (sessionId: string) =>
        removedBySession.set(sessionId, (removedBySession.get(sessionId) ?? 0) + 1);
      const projectObs = new Map<string, CompressedObservation[]>();
      const awaitingStop = new Set<string>();
      const sessionById = new Map(sessions.map((session) => [session.id, session]));
      const deleteCoveredObservation = (o: CompressedObservation) =>
        withKeyedLock(`summary:${o.sessionId}`, async () => {
          const session = sessionById.get(o.sessionId)!;
          const summary = await kv.get<SessionSummary>(KV.summaries, o.sessionId);
          const age = now - new Date(o.timestamp).getTime();
          if (
            (scannedStaleCandidates.has(o.sessionId) && (!scannedSessions.has(o.sessionId) || !summary)) ||
            (summary?.coveredThrough && (isAwaitingCompression(o) || !summaryCovers(summary, o.timestamp))) ||
            (age < staleMs && !isStopFinishedWith(o, session, summary ?? undefined))
          ) return false;
          let deleted = false;
          await deleteWithFacets(kv, async (removed) => {
            const existed = await kv.get(KV.observations(o.sessionId), o.id);
            if (!existed) return;
            await deleteIndexed(kv, KV.observations(o.sessionId), o.id);
            removed.push(o.id);
            deleted = true;
          });
          return deleted;
        });
      for (const session of sessions) {
        const obs = await kv
          .list<CompressedObservation>(KV.observations(session.id))
          .catch(() => []);
        const compressed = obs.filter((o) => o.title);
        const lowImportanceIds = new Set<string>();

        const summary = summaryBySession.get(session.id);
        for (const o of compressed) {
          if (!o.timestamp) continue;
          const age = now - new Date(o.timestamp).getTime();
          if (
            (scannedStaleCandidates.has(session.id) && (!scannedSessions.has(session.id) || !summary)) ||
            (summary?.coveredThrough && (isAwaitingCompression(o) || !summaryCovers(summary, o.timestamp))) ||
            (age < staleMs && !isStopFinishedWith(o, session, summary))
          ) {
            awaitingStop.add(o.id);
            continue;
          }
          const maxAge = cfg.lowImportanceMaxDays * MS_PER_DAY;
          if (
            age >= maxAge &&
            (o.importance ?? 5) < cfg.lowImportanceThreshold
          ) {
            if (dryRun) {
              stats.lowImportanceObs++;
              lowImportanceIds.add(o.id);
            } else {
              try {
                if (!await deleteCoveredObservation(o)) {
                  awaitingStop.add(o.id);
                  continue;
                }
                stats.lowImportanceObs++;
                lowImportanceIds.add(o.id);
                countRemoval(session.id);
                evictedSourceIds.push(o.id);
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
          const sorted = obs
            .filter((o) => !awaitingStop.has(o.id))
            .sort((a, b) => (a.importance ?? 5) - (b.importance ?? 5));
          const toEvict = sorted.slice(
            0,
            obs.length - cfg.maxObservationsPerProject,
          );
          if (dryRun) {
            stats.capEvictions += toEvict.length;
          } else {
            for (const o of toEvict) {
              try {
                if (!await deleteCoveredObservation(o)) continue;
                stats.capEvictions++;
                countRemoval(o.sessionId);
                evictedSourceIds.push(o.id);
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
                const removed = await withKeyedLock(MEMORY_WRITE_LOCK, async () => {
                  const current = await kv.get<Memory>(KV.memories, mem.id);
                  if (!current) return false;
                  await deleteWithFacets(kv, async (removed) => {
                    await deleteIndexed(kv, KV.memories, mem.id);
                    removed.push(mem.id);
                  });
                  if (current.imageRef) {
                    await decrementImageRef(kv, sdk, current.imageRef).catch((err: unknown) => {
                      logger.warn("Eviction could not release image reference", {
                        id: mem.id,
                        error: err instanceof Error ? err.message : String(err),
                      });
                    });
                  }
                  return true;
                });
                if (!removed) continue;
                stats.expiredMemories++;
                evictedMemIds.add(mem.id);
                evictedSourceIds.push(mem.id);
              } catch (err) {
                logger.warn("Eviction delete failed", {
                  resource: "memory",
                  id: mem.id,
                  reason: "expired_memory",
                  error: err instanceof Error ? err.message : String(err),
                });
                continue;
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
          if (age >= cfg.nonLatestMemoryMaxDays * MS_PER_DAY) {
            if (dryRun) {
              stats.nonLatestMemories++;
            } else {
              try {
                const removed = await withKeyedLock(MEMORY_WRITE_LOCK, async () => {
                  const current = await kv.get<Memory>(KV.memories, mem.id);
                  if (!current) return false;
                  await deleteWithFacets(kv, async (removed) => {
                    await deleteIndexed(kv, KV.memories, mem.id);
                    removed.push(mem.id);
                  });
                  if (current.imageRef) {
                    await decrementImageRef(kv, sdk, current.imageRef).catch((err: unknown) => {
                      logger.warn("Eviction could not release image reference", {
                        id: mem.id,
                        error: err instanceof Error ? err.message : String(err),
                      });
                    });
                  }
                  return true;
                });
                if (!removed) continue;
                stats.nonLatestMemories++;
                evictedSourceIds.push(mem.id);
              } catch (err) {
                logger.warn("Eviction delete failed", {
                  resource: "memory",
                  id: mem.id,
                  reason: "old_non_latest_memory",
                  error: err instanceof Error ? err.message : String(err),
                });
                continue;
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

      if (!dryRun) {
        const graph = await evictGraphForSources(kv, evictedSourceIds, "mem::evict");
        stats.graphNodes = graph.nodes;
        stats.graphEdges = graph.edges;
      }

      logger.info("Eviction complete", { stats });
      return stats;
    }),
  );
}
