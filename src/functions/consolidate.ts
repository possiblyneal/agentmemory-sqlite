import type { ISdk } from "../engine/types.js";
import type {
  CompressedObservation,
  Memory,
  Session,
  MemoryProvider,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { deindexSupersededMemory, indexNewMemoryVersion } from "./search.js";

const CONSOLIDATION_SYSTEM = `You are a memory consolidation engine. Given a set of related observations from coding sessions, synthesize them into a single long-term memory.

Output XML:
<memory>
  <type>pattern|preference|architecture|bug|workflow|fact</type>
  <title>Concise memory title (max 80 chars)</title>
  <content>2-4 sentence description of the learned insight</content>
  <concepts>
    <concept>key term</concept>
  </concepts>
  <files>
    <file>relevant/file/path</file>
  </files>
  <strength>1-10 how confident/important this memory is</strength>
</memory>`;

import { getXmlPayload, getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { logger } from "../logger.js";

function parseMemoryXml(
  response: string,
  sessionIds: string[],
): Omit<Memory, "id" | "createdAt" | "updatedAt"> | null {
  const xml = getXmlPayload(response, "memory");
  const type = getXmlTag(xml, "type");
  const title = getXmlTag(xml, "title");
  const content = getXmlTag(xml, "content");
  if (!type || !title || !content) return null;

  const validTypes = new Set([
    "pattern",
    "preference",
    "architecture",
    "bug",
    "workflow",
    "fact",
  ]);

  return {
    type: (validTypes.has(type) ? type : "fact") as Memory["type"],
    title,
    content,
    concepts: getXmlChildren(xml, "concepts", "concept"),
    files: getXmlChildren(xml, "files", "file"),
    sessionIds,
    strength: Math.max(
      1,
      Math.min(10, parseInt(getXmlTag(xml, "strength") || "5", 10) || 5),
    ),
    version: 1,
    isLatest: true,
  };
}

export function registerConsolidateFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::consolidate", 
    async (data: { project?: string; minObservations?: number }) => {
      const minObs = data.minObservations ?? 10;

      const sessions = await kv.list<Session>(KV.sessions);
      const filtered = data.project
        ? sessions.filter((s) => s.project === data.project)
        : sessions;

      const allObs: Array<CompressedObservation & { sid: string }> = [];
      const obsPerSession: CompressedObservation[][] = [];
      for (let batch = 0; batch < filtered.length; batch += 10) {
        const chunk = filtered.slice(batch, batch + 10);
        const results = await Promise.all(
          chunk.map((s) =>
            kv
              .list<CompressedObservation>(KV.observations(s.id))
              .catch(() => [] as CompressedObservation[]),
          ),
        );
        obsPerSession.push(...results);
      }
      for (let i = 0; i < filtered.length; i++) {
        for (const obs of obsPerSession[i]) {
          if (obs.title && obs.importance >= 5) {
            allObs.push({ ...obs, sid: filtered[i].id });
          }
        }
      }

      if (allObs.length < minObs) {
        return { consolidated: 0, reason: "insufficient_observations" };
      }

      const conceptGroups = new Map<string, typeof allObs>();
      for (const obs of allObs) {
        for (const concept of obs.concepts) {
          const key = concept.toLowerCase();
          if (!conceptGroups.has(key)) conceptGroups.set(key, []);
          conceptGroups.get(key)!.push(obs);
        }
      }

      let consolidated = 0;
      const existingMemories = await kv.list<Memory>(KV.memories);
      const writtenTitles = new Set<string>();
      const scopedProject =
        typeof data.project === "string" && data.project.trim().length > 0
          ? data.project.trim()
          : undefined;

      // A scoped consolidation run must only evolve memories that belong
      // to the same project, so one project's memory never evolves another's.
      // An unscoped run (no data.project, background cron path) may evolve any
      // latest memory except a Global one, which no run evolves because the
      // evolved Memory would lose its marker.
      const evolvable = (m: Memory) =>
        m.isLatest &&
        m.global !== true &&
        (!scopedProject || !m.project || m.project === scopedProject);

      const MAX_LLM_CALLS = 10;
      let llmCallCount = 0;

      const sortedGroups = [...conceptGroups.entries()]
        .filter(([, g]) => g.length >= 3)
        .sort((a, b) => b[1].length - a[1].length);

      for (const [concept, obsGroup] of sortedGroups) {
        if (llmCallCount >= MAX_LLM_CALLS) break;

        const top = obsGroup
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 8);
        const sessionIds = [...new Set(top.map((o) => o.sid))];

        const topIds = [...new Set(top.map((o) => o.id))];
        const overlapping = existingMemories.filter(
          (m) =>
            evolvable(m) &&
            m.sourceObservationIds?.some((id) => topIds.includes(id)),
        );
        if (
          overlapping.some((m) =>
            topIds.every((id) => m.sourceObservationIds?.includes(id)),
          )
        ) {
          continue;
        }

        const prompt = top
          .map(
            (o) =>
              `[${o.type}] ${o.title}\n${o.narrative}\nFiles: ${o.files.join(", ")}\nImportance: ${o.importance}`,
          )
          .join("\n\n");

        try {
          const response = await provider.compress(
            CONSOLIDATION_SYSTEM,
            `Concept: "${concept}"\n\nObservations:\n${prompt}`,
          );
          llmCallCount++;
          const parsed = parseMemoryXml(response, sessionIds);
          if (!parsed || writtenTitles.has(parsed.title.toLowerCase())) continue;

          const now = new Date().toISOString();
          const obsIds = [...new Set(top.map((o) => o.id))];
          const existingMatch =
            overlapping[0] ??
            existingMemories.find(
              (m) =>
                evolvable(m) &&
                m.title.toLowerCase() === parsed.title.toLowerCase(),
            );

          if (existingMatch) {
            existingMatch.isLatest = false;
            await kv.set(KV.memories, existingMatch.id, existingMatch);
            deindexSupersededMemory(existingMatch.id);
            await recordAudit(kv, "evolve", "mem::consolidate", [existingMatch.id], {
              action: "mark_non_latest",
              concept,
            });

            const evolved: Memory = {
              id: generateId("mem"),
              createdAt: now,
              updatedAt: now,
              ...parsed,
              version: (existingMatch.version || 1) + 1,
              parentId: existingMatch.id,
              supersedes: [
                existingMatch.id,
                ...(existingMatch.supersedes || []),
              ],
              sourceObservationIds: [
                ...new Set([...(existingMatch.sourceObservationIds ?? []), ...obsIds]),
              ],
              isLatest: true,
              ...(scopedProject !== undefined && { project: scopedProject }),
            };
            await kv.set(KV.memories, evolved.id, evolved);
            await indexNewMemoryVersion(evolved);
            existingMemories.push(evolved);
            await recordAudit(kv, "evolve", "mem::consolidate", [evolved.id], {
              action: "evolve_memory",
              oldId: existingMatch.id,
              newId: evolved.id,
              concept,
            });
            writtenTitles.add(evolved.title.toLowerCase());
            consolidated++;
          } else {
            const memory: Memory = {
              id: generateId("mem"),
              createdAt: now,
              updatedAt: now,
              ...parsed,
              sourceObservationIds: obsIds,
              version: 1,
              isLatest: true,
              ...(scopedProject !== undefined && { project: scopedProject }),
            };
            await kv.set(KV.memories, memory.id, memory);
            existingMemories.push(memory);
            await recordAudit(kv, "remember", "mem::consolidate", [memory.id], {
              action: "create_memory",
              concept,
            });
            writtenTitles.add(memory.title.toLowerCase());
            consolidated++;
          }
        } catch (err) {
          logger.warn("Consolidation failed for concept", {
            concept,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info("Consolidation complete", {
        consolidated,
        totalObs: allObs.length,
      });
      return { consolidated, totalObservations: allObs.length };
    },
  );
}
