import { TriggerAction, type ISdk } from "../engine/types.js";
import type { Memory } from "../types.js";
import { KV, generateId, jaccardSimilarity } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  memoryToIndexDoc,
  memoryChunkJobs,
  memoryToObservation,
  refersToDifferentDates,
  MEMORY_SESSION,
} from "../state/memory-utils.js";
import { recordAudit } from "./audit.js";
import { getSearchIndex, isMemoryIndexReady, vectorIndexAddBatchGuarded, vectorIndexRemove, deleteIndexed } from "./search.js";
import { getAgentId } from "../config.js";
import { logger } from "../logger.js";
import { scrubFields } from "./privacy.js";
import { graphWritesDisabled } from "./graph.js";

// Slicing by UTF-16 code unit can cut an astral character (emoji, some CJK
// extensions) mid surrogate pair, leaving a lone high surrogate that renders
// as a replacement glyph. Drop a dangling trailing high surrogate so the
// title stays valid.
function safeSlice(text: string, length: number): string {
  const sliced = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced;
}

// Signs that a caller mis-encoded its tool call and the arguments after content
// were absorbed into it as literal text. /g so match() counts every marker.
const XML_LEAK_MARKERS = [
  /<\/(?:[a-z]+:)?(?:parameter|invoke|function_calls)>/gi,
  /<parameter\s+name=/gi,
  /<\/content>/gi,
];
// A JSON argument list that closed content's string and went on to the next
// key. type counts only with a Memory type as its value, so quoted JSON such as
// a package.json "type": "module" still saves.
const JSON_LEAK =
  /["\u201d]\s*,\s*["\u201c](?:concepts["\u201d]\s*:|type["\u201d]\s*:\s*["\u201c](?:pattern|preference|architecture|bug|workflow|fact)["\u201d])/;

// More than one XML marker is required so content that legitimately mentions
// a single tag still saves.
function hasLeakedToolArgs(content: string): boolean {
  if (JSON_LEAK.test(content)) return true;
  const markers = XML_LEAK_MARKERS.reduce(
    (n, p) => n + (content.match(p)?.length ?? 0),
    0,
  );
  return markers > 1;
}

const EN_NEGATION = /\b(?:not|never|no|none|cannot|without|dont)\b|n['\u2019]t\b/i;
const CJK_NEGATION = /不|没|沒|別|别|勿|ない/;

function isNegated(text: string): boolean {
  return EN_NEGATION.test(text) || CJK_NEGATION.test(text);
}

function warnGraphExtract(memId: string, err: unknown): void {
  logger.warn("graph-extract trigger failed on remember", {
    memId,
    error: err instanceof Error ? err.message : String(err),
  });
}

export function registerRememberFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::remember", 
    async (data: {
      content: string;
      type?: string;
      concepts?: string[];
      files?: string[];
      ttlDays?: number;
      sourceObservationIds?: string[];
      agentId?: string;
      sessionId?: string;
      project?: string;
      global?: boolean;
    }) => {
      data = scrubFields(data, "content");
      if (
        !data.content ||
        typeof data.content !== "string" ||
        !data.content.trim()
      ) {
        return { success: false, error: "content is required" };
      }
      if (hasLeakedToolArgs(data.content)) {
        return {
          success: false,
          error:
            "content contains tool-call markup, so the arguments after it were " +
            "probably absorbed into content. Resend with one parameter per " +
            "argument: content, type, concepts, files, project.",
        };
      }
      if (data.sessionId !== undefined && typeof data.sessionId !== "string") {
        return { success: false, error: "sessionId must be a string" };
      }
      if (data.files && !Array.isArray(data.files)) {
        return { success: false, error: "files must be an array" };
      }
      if (data.concepts && !Array.isArray(data.concepts)) {
        return { success: false, error: "concepts must be an array" };
      }
      if (data.sourceObservationIds && !Array.isArray(data.sourceObservationIds)) {
        return { success: false, error: "sourceObservationIds must be an array" };
      }
      if (data.global !== undefined && typeof data.global !== "boolean") {
        return { success: false, error: "global must be a boolean" };
      }
      const validTypes = new Set([
        "pattern",
        "preference",
        "architecture",
        "bug",
        "workflow",
        "fact",
      ]);
      const memType = validTypes.has(data.type || "")
        ? (data.type as Memory["type"])
        : "fact";

      const now = new Date().toISOString();
      // Normalize project early so every subsequent comparison and storage
      // operation uses the same cleaned value. Raw data.project must not be
      // referenced below this point.
      const project =
        typeof data.project === "string" && data.project.trim().length > 0
          ? data.project.trim()
          : undefined;
      const sessionId = data.sessionId?.trim() || undefined;
      if (data.global && project) {
        return { success: false, error: "a Memory cannot have both a project and global" };
      }

      return withKeyedLock("mem:remember", async () => {
        // Candidate generation: query the BM25 index with the new content
        // and Jaccard-compare only the top hits, instead of walking the
        // full memory corpus on every save. The index receives every
        // memory at save time and is rebuilt at boot, so it covers the
        // corpus whenever it is non-empty; a cold, never-queried index
        // falls back to the full scan so supersession never silently
        // stops working.
        const idx = getSearchIndex();
        let candidateMemories: Memory[];
        try {
          if (isMemoryIndexReady() && idx.size > 0) {
            // 50 hits, not 20: the shared index also holds observations,
            // which occupy slots but never resolve to memories below. A
            // >0.7-Jaccard duplicate shares most tokens with the query so
            // it ranks near the top regardless. Only mem_-prefixed ids can
            // resolve in KV.memories, so skip the guaranteed-miss lookups.
            const hits = idx
              .search(data.content, 50)
              .filter((h) => h.obsId.startsWith("mem_"));
            const loaded = await Promise.all(
              hits.map((h) =>
                kv.get<Memory>(KV.memories, h.obsId).catch(() => null),
              ),
            );
            candidateMemories = loaded.filter((m): m is Memory => m !== null);
          } else {
            candidateMemories = await kv.list<Memory>(KV.memories);
          }
        } catch (err) {
          // Candidate generation is an optimization; a failure here must
          // never block the save itself.
          logger.warn("supersession candidate lookup failed, using full scan", {
            error: err instanceof Error ? err.message : JSON.stringify(err),
          });
          candidateMemories = await kv.list<Memory>(KV.memories);
        }
        let supersededId: string | undefined;
        let supersededVersion = 1;
        let supersededMemory: Memory | undefined;
        // Track the closest sub-threshold match: not similar enough to
        // supersede, but similar enough that the caller may want to
        // consolidate. Reported back as a hint; never acted on here.
        let nearMatch: { id: string; title: string; similarity: number } | undefined;
        const lowerContent = data.content.toLowerCase();
        for (const existing of candidateMemories) {
          if (existing.isLatest === false) continue;
          // Never supersede a memory that belongs to a different project.
          // Both sides must have an explicit project for the guard to engage;
          // an unscoped memory (legacy, no project field) is treated as a
          // wildcard so pre-existing data is not stranded.
          if (project && existing.project && existing.project !== project) {
            continue;
          }
          // A Global Memory and a scoped one never replace each other, so
          // supersession can neither strip the marker nor hand it to a project.
          if ((existing.global === true) !== (data.global === true)) continue;
          const similarity = jaccardSimilarity(
            lowerContent,
            existing.content.toLowerCase(),
          );
          if (
            similarity > 0.7 &&
            refersToDifferentDates(data.content, existing.content)
          ) {
            // Recurring daily reports collide above the threshold on template
            // wording alone. Measured: 2 of our 67 supersession edges were one
            // day's report erasing the previous day's, and the digest job that
            // produced them still runs. Skip rather than break - a genuinely
            // superseding memory may sit further down the list.
            logger.info("remember: refusing to supersede across dates", {
              candidateId: existing.id,
              similarity,
            });
            continue;
          }
          if (similarity > 0.7 && isNegated(data.content) !== isNegated(existing.content)) {
            // "always use X" and "never use X" are near-identical token sets
            // with opposite meaning; replacing one with the other inverts a rule.
            logger.info("remember: refusing to supersede across a polarity flip", {
              candidateId: existing.id,
              similarity,
            });
            continue;
          }
          if (similarity > 0.7) {
            supersededId = existing.id;
            supersededVersion = existing.version ?? 1;
            supersededMemory = existing;
            break;
          }
          if (
            similarity > 0.4 &&
            (!nearMatch || similarity > nearMatch.similarity)
          ) {
            nearMatch = { id: existing.id, title: existing.title, similarity };
          }
        }

        // stamp the agent role on the memory so future recall can
        // filter by agent. Request body wins (multi-agent runtimes
        // explicitly tagging at write time), env AGENT_ID fallback,
        // none → memory is unscoped (legacy behavior).
        const callAgentId =
          typeof data.agentId === "string" && data.agentId.trim().length > 0
            ? data.agentId.trim().slice(0, 128)
            : getAgentId();

        const memory: Memory = {
          id: generateId("mem"),
          createdAt: now,
          updatedAt: now,
          type: memType,
          title: safeSlice(data.content, 80),
          content: data.content,
          concepts: data.concepts || [],
          files: data.files || [],
          sessionIds: sessionId ? [sessionId] : [],
          strength: 7,
          version: supersededId ? supersededVersion + 1 : 1,
          parentId: supersededId,
          supersedes: supersededId ? [supersededId] : [],
          sourceObservationIds: (data.sourceObservationIds || []).filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
          isLatest: true,
          origin: { channel: "agent", capturedAt: now },
          ...(callAgentId ? { agentId: callAgentId } : {}),
          ...(project !== undefined && { project }),
          ...(data.global === true && { global: true }),
        };

        if (data.ttlDays && typeof data.ttlDays === "number" && data.ttlDays > 0) {
          memory.forgetAfter = new Date(Date.now() + data.ttlDays * 86400000).toISOString();
        }

        if (supersededMemory) {
          supersededMemory.isLatest = false;
          await kv.set(KV.memories, supersededMemory.id, supersededMemory);
          // De-index the superseded version. rebuildIndex() already skips
          // isLatest === false, but the live indexes keep serving the old
          // row until the next full rebuild — so the stale text competes
          // with its own replacement (and a memory-layer boost would
          // amplify exactly that). Soft-fail: the save already committed.
          try {
            getSearchIndex().remove(supersededMemory.id);
            vectorIndexRemove(supersededMemory.id);
          } catch (err) {
            logger.warn("Failed to de-index superseded memory", {
              memId: supersededMemory.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        await kv.set(KV.memories, memory.id, memory);

        // Without this, mem::remember persists the row but the BM25
        // index never sees it, so memory_smart_search and memory_recall
        // return empty even seconds after save (#257). Use try/catch so
        // an indexing failure doesn't block the save itself — the
        // restart-time rebuild will pick the memory up either way.
        try {
          getSearchIndex().add(memoryToIndexDoc(memory));
        } catch (err) {
          logger.warn("Failed to index saved memory into BM25", {
            memId: memory.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Batched so a chunked save costs ONE embed round-trip rather
        // than one per chunk. Yields a single job when chunking is off.
        const vectorSessionId = memory.sessionIds?.[0] ?? MEMORY_SESSION;
        await vectorIndexAddBatchGuarded(
          memoryChunkJobs(memory).map((job) => ({
            id: job.id,
            sessionId: vectorSessionId,
            text: job.text,
            context: { kind: "memory" as const, logId: job.id },
          })),
        );

        await recordAudit(kv, "remember", "mem::remember", [memory.id], {
          type: memory.type,
          sessionIds: memory.sessionIds,
          concepts: memory.concepts,
          files: memory.files,
          version: memory.version,
          ...(supersededId && { supersededMemoryId: supersededId }),
        });

        if (!graphWritesDisabled()) {
          try {
            sdk
              .trigger({
                function_id: "mem::graph-extract",
                payload: { observations: [memoryToObservation(memory)] },
                action: TriggerAction.Void(),
              })
              .catch((err: unknown) => warnGraphExtract(memory.id, err));
          } catch (err) {
            warnGraphExtract(memory.id, err);
          }
        }

        if (supersededId) {
          await sdk.trigger({
            function_id: "mem::cascade-update",
            payload: {
              supersededMemoryId: supersededId,
            },
            action: TriggerAction.Void(),
          });
        }

        logger.info("Memory saved", {
          memId: memory.id,
          type: memory.type,
          project: memory.project,
        });
        // similarTo is advisory only: a close-but-not-superseding match
        // the caller may want to consolidate via memory_update/forget.
        return {
          success: true,
          memory,
          ...(nearMatch && !supersededId
            ? {
                similarTo: {
                  ...nearMatch,
                  similarity: Math.round(nearMatch.similarity * 100) / 100,
                },
              }
            : {}),
        };
      });
    },
  );

  sdk.registerFunction("mem::forget",
    async (data: {
      sessionId?: string;
      observationIds?: string[];
      memoryId?: string;
    }) => {
      // The three targets are mutually exclusive in effect: naming a
      // memory disables the session wipe below, and observation ids are
      // only ever looked up inside a session. Silently honouring one and
      // dropping the other would report success for a record still there.
      if (data.observationIds && data.observationIds.length > 0 && !data.sessionId) {
        return { success: false, error: "sessionId is required with observationIds" };
      }
      if (data.memoryId && data.sessionId) {
        return { success: false, error: "name a memoryId or a sessionId, not both" };
      }

      let deleted = 0;
      const deletedMemoryIds: string[] = [];
      const deletedObservationIds: string[] = [];
      let deletedSession = false;
      const { decrementImageRef } = await import("./image-refs.js");

      if (data.memoryId) {
        const mem = await kv.get<Memory>(KV.memories, data.memoryId);
        if (mem) {
          await deleteIndexed(kv, KV.memories, data.memoryId);
          if (mem.imageRef) {
            await decrementImageRef(kv, sdk, mem.imageRef);
          }
          deletedMemoryIds.push(data.memoryId);
          deleted++;
        }
      }

      if (
        data.sessionId &&
        data.observationIds &&
        data.observationIds.length > 0
      ) {
        for (const obsId of data.observationIds) {
          const obs = await kv.get<{ imageData?: string; imageRef?: string }>(
            KV.observations(data.sessionId),
            obsId,
          );
          // An id that is not there is not an error, but it is also not a
          // removal: counting it would tell the caller their record is
          // gone when nothing of theirs was ever found.
          if (!obs) continue;
          await deleteIndexed(kv, KV.observations(data.sessionId), obsId);
          if (obs.imageData) await decrementImageRef(kv, sdk, obs.imageData);
          if (obs.imageRef && obs.imageRef !== obs.imageData) {
            await decrementImageRef(kv, sdk, obs.imageRef);
          }
          deletedObservationIds.push(obsId);
          deleted++;
        }
      }

      if (
        data.sessionId &&
        (!data.observationIds || data.observationIds.length === 0) &&
        !data.memoryId
      ) {
        const observations = await kv.list<{ id: string; imageData?: string; imageRef?: string }>(
          KV.observations(data.sessionId),
        );
        for (const obs of observations) {
          await deleteIndexed(kv, KV.observations(data.sessionId), obs.id);
          if (obs.imageData) await decrementImageRef(kv, sdk, obs.imageData);
          if (obs.imageRef && obs.imageRef !== obs.imageData) {
            await decrementImageRef(kv, sdk, obs.imageRef);
          }
          deletedObservationIds.push(obs.id);
          deleted++;
        }
        // Counted only where a record was actually there, the same rule
        // the memory and observation branches follow.
        const [session, summary] = await Promise.all([
          kv.get(KV.sessions, data.sessionId),
          kv.get(KV.summaries, data.sessionId),
        ]);
        if (session) {
          await kv.delete(KV.sessions, data.sessionId);
          deletedSession = true;
          deleted++;
        }
        if (summary) {
          await kv.delete(KV.summaries, data.sessionId);
          deleted++;
        }
      }

      if (deleted > 0) {
        await recordAudit(
          kv,
          "forget",
          "mem::forget",
          [...deletedMemoryIds, ...deletedObservationIds],
          {
            sessionId: data.sessionId,
            deleted,
            memoriesDeleted: deletedMemoryIds.length,
            observationsDeleted: deletedObservationIds.length,
            sessionDeleted: deletedSession,
            reason: "user-initiated forget",
          },
        );
      }

      logger.info("Memory forgotten", { deleted });
      return { success: true, deleted };
    },
  );
}
