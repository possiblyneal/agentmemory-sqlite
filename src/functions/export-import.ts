import type { ISdk } from "../engine/types.js";
import type {
  Session,
  CompressedObservation,
  Memory,
  SessionSummary,
  ProjectProfile,
  ExportData,
  Action,
  ActionEdge,
  Routine,
  Signal,
  Checkpoint,
  Sentinel,
  Sketch,
  Crystal,
  Facet,
  Lesson,
  Insight,
  AccessLogExport,
} from "../types.js";
import { importOrigin } from "../types.js";
import { normalizeAccessLog } from "./access-tracker.js";
import { KV } from "../state/schema.js";
import {
  indexGraphEdge,
  indexGraphNode,
  graphLegDisabled,
} from "../state/graph-indexes.js";
import { graphWritesDisabled } from "./graph.js";
import { capRecordProvenance } from "./graph-provenance.js";
import { MAX_PAYLOAD_BYTES, type OversizedPayload } from "../state/payload-bound.js";
import { StateKV } from "../state/kv.js";
import { VERSION } from "../version.js";
import { recordAudit } from "./audit.js";
import { deleteIndexed, indexRecords } from "./search.js";
import { resetLessonIndex } from "./lessons.js";
import { logger } from "../logger.js";

// Chunk size for the import delete/write loops. An import can touch up to
// MAX_TOTAL_OBSERVATIONS (~500k) records; chunking caps how many State
// calls are in flight per step instead of creating one promise per record.
const IMPORT_CHUNK_SIZE = 20;

// Run `fn` over `items` in fixed-size chunks, awaiting each chunk before
// starting the next. Preserves ordering guarantees across chunks (chunk N
// fully settles before chunk N+1 begins) while parallelizing within a
// chunk. Errors propagate — a failing item rejects the whole import, same
// as the original serial loops.
export async function runChunked<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += IMPORT_CHUNK_SIZE) {
    const chunk = items.slice(i, i + IMPORT_CHUNK_SIZE);
    await Promise.all(chunk.map(fn));
  }
}

// Every durable store a full export carries, in restore order: memories
// precede accessLogs because deleting a Memory also drops its access row.
// Snapshot create/restore reads this same list, so the two cannot drift.
export type DurableStoreField = Exclude<
  keyof ExportData,
  "version" | "exportedAt" | "observations" | "pagination"
>;

export interface DurableStore {
  field: DurableStoreField;
  scope: string;
  keyOf: (row: Record<string, unknown>) => string;
  graph?: true;
}

const byId = (row: Record<string, unknown>) => String(row.id);

export const DURABLE_STORES: readonly DurableStore[] = [
  { field: "sessions", scope: KV.sessions, keyOf: byId },
  { field: "memories", scope: KV.memories, keyOf: byId },
  { field: "summaries", scope: KV.summaries, keyOf: (s) => String(s.sessionId) },
  { field: "profiles", scope: KV.profiles, keyOf: (p) => String(p.project) },
  { field: "graphNodes", scope: KV.graphNodes, keyOf: byId, graph: true },
  { field: "graphEdges", scope: KV.graphEdges, keyOf: byId, graph: true },
  { field: "semanticMemories", scope: KV.semantic, keyOf: byId },
  { field: "proceduralMemories", scope: KV.procedural, keyOf: byId },
  { field: "actions", scope: KV.actions, keyOf: byId },
  { field: "actionEdges", scope: KV.actionEdges, keyOf: byId },
  { field: "sentinels", scope: KV.sentinels, keyOf: byId },
  { field: "sketches", scope: KV.sketches, keyOf: byId },
  { field: "crystals", scope: KV.crystals, keyOf: byId },
  { field: "facets", scope: KV.facets, keyOf: byId },
  { field: "lessons", scope: KV.lessons, keyOf: byId },
  { field: "insights", scope: KV.insights, keyOf: byId },
  { field: "routines", scope: KV.routines, keyOf: byId },
  { field: "signals", scope: KV.signals, keyOf: byId },
  { field: "checkpoints", scope: KV.checkpoints, keyOf: byId },
  { field: "accessLogs", scope: KV.accessLog, keyOf: (a) => String(a.memoryId) },
];

export type DurableRows = {
  [K in DurableStoreField]?: NonNullable<ExportData[K]>;
};

function readableStores(): DurableStore[] {
  return DURABLE_STORES.filter((s) => !(s.graph && graphLegDisabled()));
}

// B-mode (graph leg off): the graph scopes are not enumerated, so their
// fields are absent rather than empty.
export async function readDurableStores(kv: StateKV): Promise<DurableRows> {
  const readable = readableStores();
  const lists = await Promise.all(readable.map((s) => kv.list(s.scope)));
  return Object.fromEntries(readable.map((s, i) => [s.field, lists[i]]));
}

function nonEmpty<T>(rows: T[] | undefined): T[] | undefined {
  return rows && rows.length > 0 ? rows : undefined;
}

function oversizedExport(bytes: number): OversizedPayload {
  return {
    success: false,
    error: `Export is about ${(bytes / (1024 * 1024)).toFixed(1)} MiB, over the ${MAX_PAYLOAD_BYTES / (1024 * 1024)} MiB response limit; narrow the range with ?maxSessions / ?offset, or export fewer collections; the non-session collections (memories, graph, semantic, actions, lessons, ...) are not yet paginated`,
    oversized: true,
    bytes,
    limitBytes: MAX_PAYLOAD_BYTES,
  };
}

export function registerExportImportFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::export", 
    async (data?: { maxSessions?: number; offset?: number }) => {
      const rawMax = Number(data?.maxSessions);
      const maxSessions = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(Math.floor(rawMax), 1000) : undefined;
      const rawOffset = Number(data?.offset);
      const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;

      const allSessions = await kv.list<Session>(KV.sessions);
      const paginatedSessions = maxSessions !== undefined
        ? allSessions.slice(offset, offset + maxSessions)
        : allSessions;

      const scopes = [
        ...readableStores().map((s) => s.scope),
        ...paginatedSessions.map((s) => KV.observations(s.id)),
      ];
      const estimatedBytes = (await Promise.all(scopes.map((scope) => kv.bytes(scope)))).reduce(
        (sum, n) => sum + n,
        0,
      );
      if (estimatedBytes > MAX_PAYLOAD_BYTES) {
        logger.warn("Export refused before it was built", { estimatedBytes });
        return oversizedExport(estimatedBytes);
      }

      const stores = await readDurableStores(kv);
      const memories = stores.memories ?? [];
      const summaries = stores.summaries ?? [];

      const observations: Record<string, CompressedObservation[]> = {};
      const obsResults = await Promise.all(
        paginatedSessions.map((session) =>
          kv
            .list<CompressedObservation>(KV.observations(session.id))
            .catch(() => [] as CompressedObservation[])
            .then((obs) => ({ sessionId: session.id, obs })),
        ),
      );
      for (const { sessionId, obs } of obsResults) {
        if (obs.length > 0) {
          observations[sessionId] = obs;
        }
      }

      const uniqueProjects = new Set(paginatedSessions.map((s) => s.project));
      const profiles = (stores.profiles ?? []).filter((p) =>
        uniqueProjects.has(p.project),
      );

      const exportData: ExportData = {
        version: VERSION,
        exportedAt: new Date().toISOString(),
        sessions: paginatedSessions,
        observations,
        memories,
        summaries,
        profiles: nonEmpty(profiles),
        graphNodes: nonEmpty(stores.graphNodes),
        graphEdges: nonEmpty(stores.graphEdges),
        semanticMemories: nonEmpty(stores.semanticMemories),
        proceduralMemories: nonEmpty(stores.proceduralMemories),
        actions: nonEmpty(stores.actions),
        actionEdges: nonEmpty(stores.actionEdges),
        sentinels: nonEmpty(stores.sentinels),
        sketches: nonEmpty(stores.sketches),
        crystals: nonEmpty(stores.crystals),
        facets: nonEmpty(stores.facets),
        lessons: nonEmpty(stores.lessons),
        insights: nonEmpty(stores.insights),
        routines: nonEmpty(stores.routines),
        signals: nonEmpty(stores.signals),
        checkpoints: nonEmpty(stores.checkpoints),
        accessLogs: nonEmpty(stores.accessLogs),
      };

      if (maxSessions !== undefined) {
        exportData.pagination = {
          offset,
          limit: maxSessions,
          total: allSessions.length,
          hasMore: offset + maxSessions < allSessions.length,
        };
      }

      const totalObs = Object.values(observations).reduce(
        (sum, arr) => sum + arr.length,
        0,
      );
      logger.info("Export complete", {
        sessions: paginatedSessions.length,
        totalSessions: allSessions.length,
        observations: totalObs,
        memories: memories.length,
        summaries: summaries.length,
      });

      return exportData;
    },
  );

  sdk.registerFunction("mem::import", 
    async (data: {
      exportData: ExportData;
      strategy?: "merge" | "replace" | "skip";
    }) => {
      if (
        !data?.exportData ||
        typeof data.exportData !== "object" ||
        typeof (data.exportData as { version?: unknown }).version !== "string"
      ) {
        return { success: false, error: "exportData with string version is required" };
      }
      const strategy = data.strategy || "merge";
      const importData = data.exportData;

      const supportedVersions = new Set(["0.3.0", "0.4.0", "0.5.0", "0.6.0", "0.6.1", "0.7.0", "0.7.2", "0.7.3", "0.7.4", "0.7.5", "0.7.6", "0.7.7", "0.7.9", "0.8.0", "0.8.1", "0.8.2", "0.8.3", "0.8.4", "0.8.5", "0.8.6", "0.8.7", "0.8.8", "0.8.9", "0.8.10", "0.8.11", "0.8.12", "0.8.13", "0.9.0", "0.9.1", "0.9.2", "0.9.3", "0.9.4", "0.9.5", "0.9.6", "0.9.7", "0.9.8", "0.9.9", "0.9.10", "0.9.11", "0.9.12", "0.9.13", "0.9.14", "0.9.15", "0.9.16", "0.9.17", "0.9.18", "0.9.19", "0.9.20", "0.9.21", "0.9.22", "0.9.23", "0.9.24", "0.9.25", "0.9.26", "0.9.27", "0.9.28", "0.9.29"]);
      if (!supportedVersions.has(importData.version)) {
        return {
          success: false,
          error: `Unsupported export version: ${importData.version}`,
        };
      }

      const MAX_SESSIONS = 10_000;
      const MAX_MEMORIES = 50_000;
      const MAX_SUMMARIES = 10_000;
      const MAX_OBS_PER_SESSION = 5_000;
      const MAX_TOTAL_OBSERVATIONS = 500_000;
      const MAX_ACCESS_LOGS = 50_000;

      if (!Array.isArray(importData.sessions)) {
        return { success: false, error: "sessions must be an array" };
      }
      if (!Array.isArray(importData.memories)) {
        return { success: false, error: "memories must be an array" };
      }
      if (!Array.isArray(importData.summaries)) {
        return { success: false, error: "summaries must be an array" };
      }
      if (
        typeof importData.observations !== "object" ||
        importData.observations === null ||
        Array.isArray(importData.observations)
      ) {
        return { success: false, error: "observations must be an object" };
      }

      if (importData.sessions.length > MAX_SESSIONS) {
        return {
          success: false,
          error: `Too many sessions (max ${MAX_SESSIONS})`,
        };
      }
      if (importData.memories.length > MAX_MEMORIES) {
        return {
          success: false,
          error: `Too many memories (max ${MAX_MEMORIES})`,
        };
      }
      if (importData.summaries.length > MAX_SUMMARIES) {
        return {
          success: false,
          error: `Too many summaries (max ${MAX_SUMMARIES})`,
        };
      }
      const MAX_OBS_BUCKETS = 10_000;
      const obsBuckets = Object.keys(importData.observations);
      if (obsBuckets.length > MAX_OBS_BUCKETS) {
        return {
          success: false,
          error: `Too many observation buckets (max ${MAX_OBS_BUCKETS})`,
        };
      }

      let totalObservations = 0;
      for (const [, obs] of Object.entries(importData.observations)) {
        if (!Array.isArray(obs)) {
          return { success: false, error: "observation values must be arrays" };
        }
        if (obs.length > MAX_OBS_PER_SESSION) {
          return {
            success: false,
            error: `Too many observations per session (max ${MAX_OBS_PER_SESSION})`,
          };
        }
        totalObservations += obs.length;
      }
      if (totalObservations > MAX_TOTAL_OBSERVATIONS) {
        return {
          success: false,
          error: `Too many total observations (max ${MAX_TOTAL_OBSERVATIONS})`,
        };
      }

      const stats = {
        sessions: 0,
        observations: 0,
        memories: 0,
        summaries: 0,
        skipped: 0,
      };

      if (strategy === "replace") {
        const existing = await kv.list<Session>(KV.sessions);
        // Collect observation deletes across all sessions, then run them in
        // one bounded pass: a runChunked nested inside a runChunked callback
        // multiplies in-flight deletes to chunk-size squared.
        const obsDeletes: Array<{ sessionId: string; obsId: string }> = [];
        await runChunked(existing, async (session) => {
          await kv.delete(KV.sessions, session.id);
          const obs = await kv
            .list<CompressedObservation>(KV.observations(session.id))
            .catch(() => []);
          for (const o of obs) {
            obsDeletes.push({ sessionId: session.id, obsId: o.id });
          }
        });
        await runChunked(obsDeletes, (d) =>
          deleteIndexed(kv, KV.observations(d.sessionId), d.obsId),
        );
        await runChunked(await kv.list<Memory>(KV.memories), (m) =>
          deleteIndexed(kv, KV.memories, m.id),
        );
        await runChunked(
          await kv.list<SessionSummary>(KV.summaries),
          (s) => kv.delete(KV.summaries, s.sessionId),
        );
        await runChunked(await kv.list<Action>(KV.actions).catch(() => []), (a) =>
          kv.delete(KV.actions, a.id),
        );
        await runChunked(
          await kv.list<ActionEdge>(KV.actionEdges).catch(() => []),
          (e) => kv.delete(KV.actionEdges, e.id),
        );
        await runChunked(
          await kv.list<Routine>(KV.routines).catch(() => []),
          (r) => kv.delete(KV.routines, r.id),
        );
        await runChunked(
          await kv.list<Signal>(KV.signals).catch(() => []),
          (s) => kv.delete(KV.signals, s.id),
        );
        await runChunked(
          await kv.list<Checkpoint>(KV.checkpoints).catch(() => []),
          (c) => kv.delete(KV.checkpoints, c.id),
        );
        await runChunked(
          await kv.list<Sentinel>(KV.sentinels).catch(() => []),
          (s) => kv.delete(KV.sentinels, s.id),
        );
        await runChunked(
          await kv.list<Sketch>(KV.sketches).catch(() => []),
          (s) => kv.delete(KV.sketches, s.id),
        );
        await runChunked(
          await kv.list<Crystal>(KV.crystals).catch(() => []),
          (c) => kv.delete(KV.crystals, c.id),
        );
        await runChunked(
          await kv.list<Facet>(KV.facets).catch(() => []),
          (f) => kv.delete(KV.facets, f.id),
        );
        await runChunked(
          await kv.list<Lesson>(KV.lessons).catch(() => []),
          (l) => kv.delete(KV.lessons, l.id),
        );
        resetLessonIndex();
        await runChunked(
          await kv.list<Insight>(KV.insights).catch(() => []),
          (i) => kv.delete(KV.insights, i.id),
        );
        // Fork posture: a replace-import wipes the graph scope only when it
        // may also restore it (same gate as the import below), so the graph
        // is either replaced whole or left untouched - never emptied.
        if (!graphWritesDisabled()) {
          await runChunked(
            await kv.list<{ id: string }>(KV.graphNodes).catch(() => []),
            (n) => kv.delete(KV.graphNodes, n.id),
          );
          await runChunked(
            await kv.list<{ id: string }>(KV.graphEdges).catch(() => []),
            (e) => kv.delete(KV.graphEdges, e.id),
          );
        }
        await runChunked(
          await kv.list<{ id: string }>(KV.semantic).catch(() => []),
          (s) => kv.delete(KV.semantic, s.id),
        );
        await runChunked(
          await kv.list<{ id: string }>(KV.procedural).catch(() => []),
          (p) => kv.delete(KV.procedural, p.id),
        );
        await runChunked(
          await kv.list<ProjectProfile>(KV.profiles).catch(() => []),
          (profile) => kv.delete(KV.profiles, profile.project),
        );
        await runChunked(
          await kv.list<AccessLogExport>(KV.accessLog).catch(() => []),
          (a) => kv.delete(KV.accessLog, a.memoryId),
        );
      }

      // Records actually written this run, accumulated for search
      // indexing after the KV writes settle. Skipped (already-present)
      // and merge-overwritten rows are already in the index or will be
      // re-added below, so re-indexing them is harmless; we only skip the
      // ones the "skip" strategy declined to write.
      const indexObs: CompressedObservation[] = [];
      const indexMems: Memory[] = [];

      await runChunked(importData.sessions, async (session) => {
        if (strategy === "skip") {
          const existing = await kv
            .get<Session>(KV.sessions, session.id)
            .catch(() => null);
          if (existing) {
            stats.skipped++;
            return;
          }
        }
        await kv.set(KV.sessions, session.id, session);
        stats.sessions++;
      });

      for (const [sessionId, obs] of Object.entries(importData.observations)) {
        await runChunked(obs, async (o) => {
          if (strategy === "skip") {
            const existing = await kv
              .get<CompressedObservation>(KV.observations(sessionId), o.id)
              .catch(() => null);
            if (existing) {
              stats.skipped++;
              return;
            }
          }
          o.origin = importOrigin(o.origin, o.timestamp);
          await kv.set(KV.observations(sessionId), o.id, o);
          stats.observations++;
          indexObs.push(o);
        });
      }

      await runChunked(importData.memories, async (memory) => {
        if (strategy === "skip") {
          const existing = await kv
            .get<Memory>(KV.memories, memory.id)
            .catch(() => null);
          if (existing) {
            stats.skipped++;
            return;
          }
        }
        // Older exports + hand-edited dumps can omit this field.
        if (!Array.isArray(memory.sessionIds)) {
          memory.sessionIds = [];
        }
        memory.origin = importOrigin(memory.origin, memory.createdAt);
        await kv.set(KV.memories, memory.id, memory);
        stats.memories++;
        indexMems.push(memory);
      });

      await runChunked(importData.summaries, async (summary) => {
        if (strategy === "skip") {
          const existing = await kv
            .get<SessionSummary>(KV.summaries, summary.sessionId)
            .catch(() => null);
          if (existing) {
            stats.skipped++;
            return;
          }
        }
        await kv.set(KV.summaries, summary.sessionId, summary);
        stats.summaries++;
      });

      // Fork posture (graph-off): graph rows in an import file are written
      // only when graph writes are allowed (see graphWritesDisabled), and
      // every written row also lands in the #893 side-indexes the read
      // path depends on.
      if (importData.graphNodes && !graphWritesDisabled()) {
        await runChunked(importData.graphNodes, async (node) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.graphNodes, node.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          const bounded = capRecordProvenance(node);
          await kv.set(KV.graphNodes, bounded.id, bounded);
          await indexGraphNode(kv, bounded);
        });
      }
      if (importData.graphEdges && !graphWritesDisabled()) {
        await runChunked(importData.graphEdges, async (edge) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.graphEdges, edge.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          const bounded = capRecordProvenance(edge);
          await kv.set(KV.graphEdges, bounded.id, bounded);
          await indexGraphEdge(kv, bounded);
        });
      }
      if (importData.semanticMemories) {
        await runChunked(importData.semanticMemories, async (sem) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.semantic, sem.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          await kv.set(KV.semantic, sem.id, sem);
        });
      }
      if (importData.proceduralMemories) {
        await runChunked(importData.proceduralMemories, async (proc) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.procedural, proc.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          await kv.set(KV.procedural, proc.id, proc);
        });
      }
      if (importData.profiles) {
        await runChunked(importData.profiles, async (profile) => {
          if (strategy === "skip") {
            const existing = await kv
              .get<ProjectProfile>(KV.profiles, profile.project)
              .catch(() => null);
            if (existing) {
              stats.skipped++;
              return;
            }
          }
          await kv.set(KV.profiles, profile.project, profile);
        });
      }

      if (importData.actions) {
        await runChunked(importData.actions, async (action) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.actions, action.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          await kv.set(KV.actions, action.id, action);
        });
      }
      if (importData.actionEdges) {
        await runChunked(importData.actionEdges, async (edge) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.actionEdges, edge.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          await kv.set(KV.actionEdges, edge.id, edge);
        });
      }
      if (importData.routines) {
        await runChunked(importData.routines, async (routine) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.routines, routine.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          await kv.set(KV.routines, routine.id, routine);
        });
      }
      if (importData.signals) {
        await runChunked(importData.signals, async (signal) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.signals, signal.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          await kv.set(KV.signals, signal.id, signal);
        });
      }
      if (importData.checkpoints) {
        await runChunked(importData.checkpoints, async (checkpoint) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.checkpoints, checkpoint.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          await kv.set(KV.checkpoints, checkpoint.id, checkpoint);
        });
      }
      if (importData.sentinels) {
        await runChunked(importData.sentinels, async (sentinel) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.sentinels, sentinel.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          await kv.set(KV.sentinels, sentinel.id, sentinel);
        });
      }
      if (importData.sketches) {
        await runChunked(importData.sketches, async (sketch) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.sketches, sketch.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          await kv.set(KV.sketches, sketch.id, sketch);
        });
      }
      if (importData.crystals) {
        await runChunked(importData.crystals, async (crystal) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.crystals, crystal.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          await kv.set(KV.crystals, crystal.id, crystal);
        });
      }
      if (importData.facets) {
        await runChunked(importData.facets, async (facet) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.facets, facet.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          await kv.set(KV.facets, facet.id, facet);
        });
      }
      if (importData.lessons) {
        await runChunked(importData.lessons, async (lesson) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.lessons, lesson.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          await kv.set(KV.lessons, lesson.id, lesson);
        });
        resetLessonIndex();
      }
      if (importData.insights) {
        await runChunked(importData.insights, async (insight) => {
          if (strategy === "skip") {
            const existing = await kv.get(KV.insights, insight.id).catch(() => null);
            if (existing) { stats.skipped++; return; }
          }
          await kv.set(KV.insights, insight.id, insight);
        });
      }
      if (importData.accessLogs) {
        if (!Array.isArray(importData.accessLogs)) {
          return { success: false, error: "accessLogs must be an array" };
        }
        if (importData.accessLogs.length > MAX_ACCESS_LOGS) {
          return {
            success: false,
            error: `Too many access logs (max ${MAX_ACCESS_LOGS})`,
          };
        }
        const memoryIds = new Set<string>(
          importData.memories.map((m) => m.id),
        );
        await runChunked(importData.accessLogs, async (raw) => {
          const log = normalizeAccessLog(raw);
          if (!log.memoryId || !memoryIds.has(log.memoryId)) return;
          if (strategy === "skip") {
            const existing = await kv
              .get(KV.accessLog, log.memoryId)
              .catch(() => null);
            if (existing) {
              stats.skipped++;
              return;
            }
          }
          await kv.set(KV.accessLog, log.memoryId, log);
        });
      }

      // Imported rows are now in KV but invisible to search: the boot
      // rebuild gate only fires when BM25 is empty, so on any existing
      // install (non-empty persisted index) imported observations and
      // memories never surface via mem::search / smart-search until a
      // manual rebuild. Add them to BM25 (synchronous) and enqueue the
      // vector embeddings in batches (one embedBatch call per chunk)
      // rather than one giant Promise.all over 500k docs. Indexing
      // failures are logged, not fatal — the KV writes already committed
      // and the restart rebuild is the backstop.
      try {
        await indexRecords(indexObs, indexMems);
      } catch (err) {
        logger.warn("Import indexing failed; restart rebuild will recover", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      logger.info("Import complete", { strategy, ...stats });
      await recordAudit(kv, "import", "mem::import", [], {
        strategy,
        stats,
      });
      return { success: true, strategy, ...stats };
    },
  );
}
