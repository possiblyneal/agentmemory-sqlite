import type { GraphEdge, GraphNode, GraphSnapshot } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  graphLegDisabled,
  isLiveGraphRecord,
  loadAdjacentEdgeIds,
  loadNodeIdsForObservations,
  unindexGraphEdge,
  unindexGraphNode,
  unlinkObservationNodes,
} from "../state/graph-indexes.js";
import { getMaxSourceObservationIds } from "../config.js";
import {
  GRAPH_WRITE_LOCK,
  SNAPSHOT_KEY,
  applyDegreeDelta,
  edgeIndexKey,
  loadSnapshot,
  nameIndexKey,
} from "./graph.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";

// Graph Eviction: an Entity or Relation whose recorded Provenance names only
// Observations and Memories that are no longer stored is removed with them.
// Provenance is capped, so a list at the cap may have dropped sources it can
// no longer name; only a list below the cap is a complete account of origin.

export interface GraphEvictionCounts {
  nodes: number;
  edges: number;
}

const NONE: GraphEvictionCounts = { nodes: 0, edges: 0 };

const SOURCE_SCOPE_PREFIXES = [KV.observations(""), KV.memories];

async function liveSourceIds(kv: StateKV, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  const found = await Promise.all(
    SOURCE_SCOPE_PREFIXES.map((prefix) => kv.existingKeys(prefix, unique)),
  );
  return new Set(found.flat());
}

function provenanceGone(
  ids: string[] | undefined,
  live: Set<string>,
  cap: number,
): boolean {
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.length < cap &&
    ids.every((id) => !live.has(id))
  );
}

// Edges extracted from one source join Entities extracted from it, so the
// Relations a source can orphan sit in the adjacency of two of its Entities.
// Intersecting the id lists finds them without reading a hub's every edge.
function edgesSharedByNodes(adjacency: string[][]): string[] {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const edgeIds of adjacency) {
    for (const id of new Set(edgeIds)) {
      if (seen.has(id)) shared.add(id);
      else seen.add(id);
    }
  }
  return [...shared];
}

async function getMany<T>(kv: StateKV, scope: string, ids: string[]): Promise<T[]> {
  const rows = await Promise.all(ids.map((id) => kv.get<T>(scope, id)));
  return rows.filter((r): r is NonNullable<typeof r> => r != null) as T[];
}

async function removeEdges(
  kv: StateKV,
  snap: GraphSnapshot | null,
  edges: GraphEdge[],
  removedNodeIds: Set<string>,
): Promise<void> {
  for (const edge of edges) {
    const live = isLiveGraphRecord(edge, snap?.resetAt);
    await kv.delete(KV.graphEdges, edge.id);
    await kv.delete(KV.graphEdgeHistory, edge.id);
    const key = edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type);
    if ((await kv.get<string>(KV.graphEdgeKey, key)) === edge.id) {
      await kv.delete(KV.graphEdgeKey, key);
    }
    for (const nodeId of new Set([edge.sourceNodeId, edge.targetNodeId])) {
      if (!removedNodeIds.has(nodeId)) await unindexGraphEdge(kv, nodeId, edge.id);
    }
    if (live) {
      for (const nodeId of [edge.sourceNodeId, edge.targetNodeId]) {
        if (removedNodeIds.has(nodeId)) continue;
        if (snap) await applyDegreeDelta(kv, snap, nodeId, -1);
        else {
          const degree = (await kv.get<number>(KV.graphNodeDegree, nodeId)) ?? 0;
          await kv.set(KV.graphNodeDegree, nodeId, Math.max(0, degree - 1));
        }
      }
    }
    if (!snap) continue;
    snap.topEdges = snap.topEdges.filter((e) => e.id !== edge.id);
    if (live) {
      snap.stats.totalEdges = Math.max(0, snap.stats.totalEdges - 1);
      snap.stats.edgesByType[edge.type] = Math.max(
        0,
        (snap.stats.edgesByType[edge.type] ?? 0) - 1,
      );
    }
  }
}

async function removeNodes(
  kv: StateKV,
  snap: GraphSnapshot | null,
  nodes: GraphNode[],
): Promise<void> {
  for (const node of nodes) {
    await kv.delete(KV.graphNodes, node.id);
    const key = nameIndexKey(node.type, node.name);
    if ((await kv.get<string>(KV.graphNameIndex, key)) === node.id) {
      await kv.delete(KV.graphNameIndex, key);
    }
    await kv.delete(KV.graphNodeDegree, node.id);
    await unindexGraphNode(kv, node);
    if (!snap) continue;
    snap.topNodes = snap.topNodes.filter((n) => n.id !== node.id);
    delete snap.topDegrees[node.id];
    if (isLiveGraphRecord(node, snap.resetAt)) {
      snap.stats.totalNodes = Math.max(0, snap.stats.totalNodes - 1);
      snap.stats.nodesByType[node.type] = Math.max(
        0,
        (snap.stats.nodesByType[node.type] ?? 0) - 1,
      );
    }
  }
}

// Caller holds GRAPH_WRITE_LOCK, so Extraction cannot add a source to one of
// these records between the liveness check and the delete. A removed node
// takes every incident edge with it; an edge left without an endpoint is
// removed whatever its Provenance says.
async function pruneUnlocked(
  kv: StateKV,
  nodes: GraphNode[],
  edges: GraphEdge[],
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  if (nodes.length === 0 && edges.length === 0) return { nodes: [], edges: [] };
  const snap = await loadSnapshot(kv);
  const cap = getMaxSourceObservationIds();
  const [live, presentNodes] = await Promise.all([
    liveSourceIds(
      kv,
      [...nodes, ...edges].flatMap((r) => r.sourceObservationIds ?? []),
    ),
    kv.existingKeys(
      KV.graphNodes,
      [...new Set(edges.flatMap((e) => [e.sourceNodeId, e.targetNodeId]))],
    ),
  ]);
  const deadNodes = nodes.filter((n) =>
    provenanceGone(n.sourceObservationIds, live, cap),
  );
  const deadNodeIds = new Set(deadNodes.map((n) => n.id));
  const present = new Set(presentNodes);
  const deadEdges = new Map<string, GraphEdge>();
  for (const edge of edges) {
    if (
      provenanceGone(edge.sourceObservationIds, live, cap) ||
      !present.has(edge.sourceNodeId) ||
      !present.has(edge.targetNodeId) ||
      deadNodeIds.has(edge.sourceNodeId) ||
      deadNodeIds.has(edge.targetNodeId)
    ) {
      deadEdges.set(edge.id, edge);
    }
  }
  for (const node of deadNodes) {
    const incident = (await loadAdjacentEdgeIds(kv, node.id)).filter(
      (id) => !deadEdges.has(id),
    );
    for (const edge of await getMany<GraphEdge>(kv, KV.graphEdges, incident)) {
      deadEdges.set(edge.id, edge);
    }
  }

  await removeEdges(kv, snap, [...deadEdges.values()], deadNodeIds);
  await removeNodes(kv, snap, deadNodes);
  if (snap && (deadNodes.length > 0 || deadEdges.size > 0)) {
    snap.updatedAt = new Date().toISOString();
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
  }
  return { nodes: deadNodes, edges: [...deadEdges.values()] };
}

async function auditRemoval(
  kv: StateKV,
  functionId: string,
  removed: { nodes: GraphNode[]; edges: GraphEdge[] },
  details: Record<string, unknown>,
): Promise<GraphEvictionCounts> {
  const counts = { nodes: removed.nodes.length, edges: removed.edges.length };
  if (counts.nodes === 0 && counts.edges === 0) return counts;
  await recordAudit(
    kv,
    "delete",
    functionId,
    [...removed.nodes.map((n) => n.id), ...removed.edges.map((e) => e.id)],
    { resource: "graph", ...details, ...counts },
  );
  return counts;
}

// Call after the sources' rows are deleted. Never throws: a failure is logged
// and the orphan sweep picks the records up later. The sources' obs-node rows
// are dropped either way, as they were before Graph Eviction existed.
export async function evictGraphForSources(
  kv: StateKV,
  sourceIds: string[],
  functionId: string,
): Promise<GraphEvictionCounts> {
  if (sourceIds.length === 0) return NONE;
  try {
    if (graphLegDisabled()) return NONE;
    const nodeIds = await loadNodeIdsForObservations(kv, sourceIds);
    if (nodeIds.length === 0) return NONE;
    const adjacency = await Promise.all(
      nodeIds.map((id) => loadAdjacentEdgeIds(kv, id)),
    );
    const removed = await withKeyedLock(GRAPH_WRITE_LOCK, async () =>
      pruneUnlocked(
        kv,
        await getMany<GraphNode>(kv, KV.graphNodes, nodeIds),
        await getMany<GraphEdge>(kv, KV.graphEdges, edgesSharedByNodes(adjacency)),
      ),
    );
    return await auditRemoval(kv, functionId, removed, {
      reason: "sources_evicted",
      sourceIds,
    });
  } catch (err) {
    logger.warn("Graph eviction failed", {
      functionId,
      sources: sourceIds.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return NONE;
  } finally {
    await Promise.all(sourceIds.map((id) => unlinkObservationNodes(kv, id)));
  }
}

interface SweepCursor {
  phase: "nodes" | "edges" | "obs-nodes";
  after?: string;
}
const SWEEP_KEY = "system:graphOrphanSweep";
const SWEEP_PAGE = 500;
const SWEEP_PHASES: SweepCursor["phase"][] = ["nodes", "edges", "obs-nodes"];

export interface GraphSweepCounts extends GraphEvictionCounts {
  obsLinks: number;
}

// Catches what source-time eviction cannot see: records orphaned before it
// existed, sources whose obs-node row was capped short of a node, and nodes
// left by a Memory eviction or with the graph leg off. One full pass per
// call, a page at a time under the write lock; the cursor is saved after each
// page, so a pass cut short by a restart resumes where it stopped.
export async function sweepOrphanedGraph(
  kv: StateKV,
  functionId: string,
): Promise<GraphSweepCounts> {
  const totals: GraphSweepCounts = { nodes: 0, edges: 0, obsLinks: 0 };
  if (graphLegDisabled()) return totals;
  let cursor: SweepCursor = (await kv.get<SweepCursor>(KV.state, SWEEP_KEY)) ?? {
    phase: "nodes",
  };
  for (;;) {
    let lastKey: string | undefined;
    if (cursor.phase === "obs-nodes") {
      const rows = await kv.listPage<string[]>(KV.graphObsNodes, cursor.after, SWEEP_PAGE);
      lastKey = rows.at(-1)?.key;
      const live = await liveSourceIds(kv, rows.map((r) => r.key));
      const gone = rows.filter((r) => !live.has(r.key)).map((r) => r.key);
      await Promise.all(gone.map((id) => unlinkObservationNodes(kv, id)));
      totals.obsLinks += gone.length;
    } else {
      const phase = cursor.phase;
      const after = cursor.after;
      const removed = await withKeyedLock(GRAPH_WRITE_LOCK, async () => {
        const scope = phase === "nodes" ? KV.graphNodes : KV.graphEdges;
        const rows = await kv.listPage<GraphNode & GraphEdge>(scope, after, SWEEP_PAGE);
        lastKey = rows.at(-1)?.key;
        const records = rows.map((r) => r.value);
        return phase === "nodes"
          ? pruneUnlocked(kv, records, [])
          : pruneUnlocked(kv, [], records);
      });
      const counts = await auditRemoval(kv, functionId, removed, {
        reason: "orphaned_provenance",
      });
      totals.nodes += counts.nodes;
      totals.edges += counts.edges;
    }

    if (lastKey !== undefined) {
      cursor = { phase: cursor.phase, after: lastKey };
    } else {
      const next = SWEEP_PHASES[SWEEP_PHASES.indexOf(cursor.phase) + 1];
      if (!next) {
        await kv.delete(KV.state, SWEEP_KEY);
        return totals;
      }
      cursor = { phase: next };
    }
    await kv.set(KV.state, SWEEP_KEY, cursor);
  }
}
