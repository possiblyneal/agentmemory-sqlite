import { deleteWithFacets } from "./facets.js";
import type { ISdk } from "../engine/types.js";
import type { Memory, CompressedObservation, Session } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { deleteIndexed, deindexSupersededMemory } from "./search.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { lowerObservationCounts } from "./observe.js";
import { evictGraphForSources } from "./graph-eviction.js";
import { refersToDifferentDates, MEMORY_WRITE_LOCK } from "../state/memory-utils.js";
import { logger } from "../logger.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CONTRADICTION_THRESHOLD = 0.9;

function sameSupersessionScope(a: Memory, b: Memory): boolean {
  return a.project === b.project &&
    (a.global === true) === (b.global === true) &&
    a.agentId === b.agentId;
}

function contradictionTokens(content: string): Set<string> {
  return new Set(content.toLowerCase().split(/\s+/).filter((word) => word.length > 2));
}

function contradictionSimilarity(a: Memory, b: Memory, setA: Set<string>, setB: Set<string>): number {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const similarity = intersection / (setA.size + setB.size - intersection);
  // Daily reports for different dates are not contradictions, even if their text nearly matches.
  return similarity > CONTRADICTION_THRESHOLD && sameSupersessionScope(a, b) &&
    !refersToDifferentDates(a.content, b.content) ? similarity : 0;
}

interface AutoForgetResult {
  ttlExpired: string[];
  contradictions: Array<{
    memoryA: string;
    memoryB: string;
    similarity: number;
  }>;
  lowValueObs: string[];
  dryRun: boolean;
}

export function registerAutoForgetFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::auto-forget", 
    async (data: { dryRun?: boolean }): Promise<AutoForgetResult> => {
      const dryRun = data?.dryRun ?? false;
      const now = Date.now();
      const { decrementImageRef } = await import("./image-refs.js");

      const result: AutoForgetResult = {
        ttlExpired: [],
        contradictions: [],
        lowValueObs: [],
        dryRun,
      };

      const memories = await kv.list<Memory>(KV.memories);
      const deletedIds = new Set<string>();
      const evictedSourceIds: string[] = [];
      for (const mem of memories) {
        if (mem.forgetAfter) {
          const expiry = new Date(mem.forgetAfter).getTime();
          if (now > expiry) {
            result.ttlExpired.push(mem.id);
            deletedIds.add(mem.id);
            if (!dryRun) {
              await withKeyedLock(MEMORY_WRITE_LOCK, async () => {
                const current = await kv.get<Memory>(KV.memories, mem.id);
                if (!current) return;
                await deleteWithFacets(kv, async (removed) => {
                  await deleteIndexed(kv, KV.memories, mem.id);
                  removed.push(mem.id);
                });
                if (current.imageRef) {
                  await decrementImageRef(kv, sdk, current.imageRef).catch((error) => {
                    logger.warn("Auto-forget could not release image reference", { memoryId: current.id, error: String(error) });
                  });
                }
              });
              evictedSourceIds.push(mem.id);
              await recordAudit(kv, "delete", "mem::auto-forget", [mem.id], {
                resource: "memory",
                reason: "auto-forget TTL",
                timestamp: mem.forgetAfter,
              });
            }
          }
        }
      }

      const latestMemories = memories
        .filter((m) => m.isLatest !== false && !deletedIds.has(m.id))
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        .slice(0, 1000);

      const tokenCache = new Map(latestMemories.map((mem) => [mem.id, contradictionTokens(mem.content)]));
      const memById = new Map(latestMemories.map((m) => [m.id, m]));
      const conceptIndex = new Map<string, string[]>();
      for (const mem of latestMemories) {
        const concepts = mem.concepts || [];
        for (const c of concepts) {
          const key = c.toLowerCase();
          if (!conceptIndex.has(key)) conceptIndex.set(key, []);
          conceptIndex.get(key)!.push(mem.id);
        }
      }

      const compared = new Set<string>();
      for (const [, memIds] of conceptIndex) {
        for (let i = 0; i < memIds.length; i++) {
          for (let j = i + 1; j < memIds.length; j++) {
            const key =
              memIds[i] < memIds[j]
                ? `${memIds[i]}|${memIds[j]}`
                : `${memIds[j]}|${memIds[i]}`;
            if (compared.has(key)) continue;
            compared.add(key);

            const memA = memById.get(memIds[i])!;
            const memB = memById.get(memIds[j])!;
            if (memA.id === memB.id) continue;
            const similarity = contradictionSimilarity(memA, memB, tokenCache.get(memA.id)!, tokenCache.get(memB.id)!);
            if (!similarity) continue;
            if (dryRun) {
              result.contradictions.push({ memoryA: memA.id, memoryB: memB.id, similarity });
              continue;
            }

            const demotion = await withKeyedLock(MEMORY_WRITE_LOCK, async () => {
              const [a, b] = await Promise.all([
                kv.get<Memory>(KV.memories, memA.id),
                kv.get<Memory>(KV.memories, memB.id),
              ]);
              if (!a || !b || a.isLatest === false || b.isLatest === false) return;
              const conceptsB = new Set(b.concepts?.map((concept) => concept.toLowerCase()));
              if (!a.concepts?.some((concept) => conceptsB.has(concept.toLowerCase()))) return;
              const similarity = contradictionSimilarity(a, b, contradictionTokens(a.content), contradictionTokens(b.content));
              if (!similarity) return;
              const older = new Date(a.createdAt).getTime() < new Date(b.createdAt).getTime() ? a : b;
              await kv.set(KV.memories, older.id, { ...older, isLatest: false });
              deindexSupersededMemory(older.id);
              return { olderId: older.id, similarity };
            });
            if (!demotion) continue;
            result.contradictions.push({ memoryA: memA.id, memoryB: memB.id, similarity: demotion.similarity });
            await recordAudit(kv, "forget", "mem::auto-forget", [demotion.olderId], {
              resource: "memory",
              reason: "auto-forget contradiction",
              ...demotion,
            });
          }
        }
      }

      const sessions = await kv.list<Session>(KV.sessions);
      const obsPerSession: CompressedObservation[][] = [];
      for (let batch = 0; batch < sessions.length; batch += 10) {
        const chunk = sessions.slice(batch, batch + 10);
        const results = await Promise.all(
          chunk.map((s) =>
            kv
              .list<CompressedObservation>(KV.observations(s.id))
              .catch(() => [] as CompressedObservation[]),
          ),
        );
        obsPerSession.push(...results);
      }
      const removedBySession = new Map<string, number>();
      for (let i = 0; i < sessions.length; i++) {
        for (const obs of obsPerSession[i]) {
          if (!obs.timestamp) continue;
          const age = now - new Date(obs.timestamp).getTime();
          if (age > 180 * MS_PER_DAY && (obs.importance ?? 5) <= 2) {
            result.lowValueObs.push(obs.id);
            if (!dryRun) {
              let deletedOk = false;
              try {
                await deleteWithFacets(kv, async (removed) => {
                  const existed = await kv.get(KV.observations(sessions[i].id), obs.id);
                  await deleteIndexed(kv, KV.observations(sessions[i].id), obs.id);
                  if (existed) removed.push(obs.id);
                });
                deletedOk = true;
              } catch {
                deletedOk = false;
              }
              if (deletedOk) {
                evictedSourceIds.push(obs.id);
                removedBySession.set(
                  sessions[i].id,
                  (removedBySession.get(sessions[i].id) ?? 0) + 1,
                );
                if (obs.imageData) await decrementImageRef(kv, sdk, obs.imageData);
                if (obs.imageRef && obs.imageRef !== obs.imageData) {
                  await decrementImageRef(kv, sdk, obs.imageRef);
                }
                await recordAudit(kv, "delete", "mem::auto-forget", [obs.id], {
                  resource: "observation",
                  reason: "auto-forget low-value observation",
                  sessionId: sessions[i].id,
                  timestamp: obs.timestamp,
                });
              }
            }
          }
        }
      }

      await lowerObservationCounts(kv, removedBySession);
      await evictGraphForSources(kv, evictedSourceIds, "mem::auto-forget");

      logger.info("Auto-forget complete", {
        ttlExpired: result.ttlExpired.length,
        contradictions: result.contradictions.length,
        lowValueObs: result.lowValueObs.length,
        dryRun,
      });
      return result;
    },
  );
}
