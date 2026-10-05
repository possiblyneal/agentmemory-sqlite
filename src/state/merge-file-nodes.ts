import type { SqliteState } from "../engine/inproc/state.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../types.js";
import { KV } from "./schema.js";
import { nameShardKey, type NameCatalogEntry } from "./graph-indexes.js";
import { noteGraphWrite } from "./kv.js";
import { capSourceIds } from "../functions/graph-provenance.js";
import { edgeIndexKey, nameIndexKey } from "../functions/graph.js";
import { projectRelative } from "../functions/project-files.js";

const GROUPS_PER_TURN = 20;
const EDGE_PAGE_ROWS = 100;

export type FileNodeMergeResult = {
  nodesMerged: number;
  edgesChanged: number;
};

type Group = { canonical: string; members: GraphNode[] };

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function oldestFirst(a: GraphNode, b: GraphNode): number {
  const at = a.updatedAt ?? a.createdAt ?? "";
  const bt = b.updatedAt ?? b.createdAt ?? "";
  return at < bt ? -1 : at > bt ? 1 : a.id < b.id ? -1 : 1;
}

function groupsToMerge(state: SqliteState, roots: string[]): Group[] {
  const rows = state.db
    .prepare(
      "SELECT value FROM kv WHERE scope = ? AND json_extract(value, '$.type') = 'file'",
    )
    .all(KV.graphNodes) as Array<{ value: string }>;
  const byName = new Map<string, GraphNode[]>();
  for (const row of rows) {
    const node = JSON.parse(row.value) as GraphNode;
    if (typeof node?.name !== "string" || !node.id) continue;
    const canonical = projectRelative(node.name, roots);
    byName.set(canonical, [...(byName.get(canonical) ?? []), node]);
  }
  return [...byName]
    .filter(([canonical, members]) => members.length > 1 || members[0]!.name !== canonical)
    .map(([canonical, members]) => ({ canonical, members: members.sort(oldestFirst) }));
}

function edgesTouching(state: SqliteState, nodeIds: Set<string>): Map<string, Set<string>> {
  const touching = new Map<string, Set<string>>();
  const page = state.db.prepare(
    "SELECT seq, key, value FROM kv WHERE scope = ? AND seq > ? ORDER BY seq LIMIT ?",
  );
  let after = 0;
  for (;;) {
    const rows = page.all(KV.graphEdges, after, EDGE_PAGE_ROWS) as Array<{
      seq: number;
      key: string;
      value: string;
    }>;
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.seq;
    for (const row of rows) {
      const edge = JSON.parse(row.value) as GraphEdge;
      for (const nodeId of [edge.sourceNodeId, edge.targetNodeId]) {
        if (!nodeIds.has(nodeId)) continue;
        touching.set(nodeId, (touching.get(nodeId) ?? new Set()).add(row.key));
      }
    }
    if (rows.length < EDGE_PAGE_ROWS) break;
  }
  return touching;
}

type SnapshotPatch = {
  removedNodes: GraphNode[];
  removedEdges: GraphEdge[];
  repointed: Map<string, GraphEdge>;
  renamed: Map<string, string>;
};

function patchSnapshot(state: SqliteState, patch: SnapshotPatch): void {
  const snap = state.get(KV.graphSnapshot, "current") as GraphSnapshot | null;
  if (!snap || snap.version !== 1) return;
  const removedNodeIds = new Set(patch.removedNodes.map((n) => n.id));
  const removedEdgeIds = new Set(patch.removedEdges.map((e) => e.id));
  snap.topNodes = snap.topNodes
    .filter((n) => !removedNodeIds.has(n.id))
    .map((n) => (patch.renamed.has(n.id) ? { ...n, name: patch.renamed.get(n.id)! } : n));
  for (const id of removedNodeIds) delete snap.topDegrees[id];
  const topIds = new Set(snap.topNodes.map((n) => n.id));
  snap.topEdges = snap.topEdges
    .filter((e) => !removedEdgeIds.has(e.id))
    .map((e) => {
      const moved = patch.repointed.get(e.id);
      return moved
        ? { ...e, sourceNodeId: moved.sourceNodeId, targetNodeId: moved.targetNodeId }
        : e;
    })
    .filter((e) => topIds.has(e.sourceNodeId) && topIds.has(e.targetNodeId));
  const decrement = (counts: Record<string, number>, type: string): void => {
    counts[type] = Math.max(0, (counts[type] ?? 0) - 1);
  };
  for (const node of patch.removedNodes) {
    if (node.stale) continue;
    snap.stats.totalNodes = Math.max(0, snap.stats.totalNodes - 1);
    decrement(snap.stats.nodesByType, node.type);
  }
  for (const edge of patch.removedEdges) {
    if (edge.stale) continue;
    snap.stats.totalEdges = Math.max(0, snap.stats.totalEdges - 1);
    decrement(snap.stats.edgesByType, edge.type);
  }
  state.set(KV.graphSnapshot, "current", snap);
}

function mergeGroup(
  state: SqliteState,
  group: Group,
  edgeIdsByNode: Map<string, Set<string>>,
  patch: SnapshotPatch,
  armed: boolean,
): void {
  const { canonical, members } = group;
  const survivor = members.find((m) => m.name === canonical) ?? members[0]!;
  const dups = members.filter((m) => m.id !== survivor.id);
  const dupIds = new Set(dups.map((d) => d.id));
  const newest = members[members.length - 1]!;

  const adjacency = new Map<string, string[] | null>();
  const adjacencyOf = (nodeId: string): string[] | null => {
    if (!adjacency.has(nodeId)) {
      const row = state.get(KV.graphAdjacency, nodeId);
      adjacency.set(nodeId, Array.isArray(row) ? (row as string[]) : armed ? [] : null);
    }
    return adjacency.get(nodeId)!;
  };
  const link = (nodeId: string, edgeId: string): void => {
    const row = adjacencyOf(nodeId);
    if (row && !row.includes(edgeId)) row.push(edgeId);
  };
  const unlink = (nodeId: string, edgeId: string): void => {
    const row = adjacencyOf(nodeId);
    if (row) adjacency.set(nodeId, row.filter((id) => id !== edgeId));
  };
  const dropKeyIndex = (edge: GraphEdge): void => {
    const key = edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type);
    if (state.get(KV.graphEdgeKey, key) === edge.id) state.delete(KV.graphEdgeKey, key);
  };

  const touched = new Set<string>([survivor.id]);
  const edgeIds = new Set(dups.flatMap((d) => [...(edgeIdsByNode.get(d.id) ?? [])]));
  for (const edgeId of edgeIds) {
    const edge = state.get(KV.graphEdges, edgeId) as GraphEdge | null;
    if (!edge) continue;
    const sourceNodeId = dupIds.has(edge.sourceNodeId) ? survivor.id : edge.sourceNodeId;
    const targetNodeId = dupIds.has(edge.targetNodeId) ? survivor.id : edge.targetNodeId;
    const moved: GraphEdge = { ...edge, sourceNodeId, targetNodeId };
    const key = edgeIndexKey(sourceNodeId, targetNodeId, edge.type);
    const twinId = state.get(KV.graphEdgeKey, key) as string | null;
    const twin =
      twinId && twinId !== edge.id
        ? (state.get(KV.graphEdges, twinId) as GraphEdge | null)
        : null;

    dropKeyIndex(edge);
    for (const endpoint of [edge.sourceNodeId, edge.targetNodeId]) {
      touched.add(endpoint);
      unlink(endpoint, edge.id);
    }
    if (sourceNodeId === targetNodeId || twin) {
      state.delete(KV.graphEdges, edge.id);
      patch.removedEdges.push(edge);
      if (twin) {
        state.set(KV.graphEdges, twin.id, {
          ...twin,
          sourceObservationIds: capSourceIds([
            ...(twin.sourceObservationIds ?? []),
            ...(edge.sourceObservationIds ?? []),
          ]),
        });
      }
    } else {
      state.set(KV.graphEdges, edge.id, moved);
      state.set(KV.graphEdgeKey, key, edge.id);
      link(sourceNodeId, edge.id);
      link(targetNodeId, edge.id);
      patch.repointed.set(edge.id, moved);
    }
  }

  for (const dup of dups) {
    for (const obsId of dup.sourceObservationIds ?? []) {
      const row = state.get(KV.graphObsNodes, obsId);
      if (!Array.isArray(row) || !row.includes(dup.id)) continue;
      state.set(
        KV.graphObsNodes,
        obsId,
        capSourceIds((row as string[]).map((id) => (id === dup.id ? survivor.id : id))),
      );
    }
  }

  const shardOf = (nodeId: string): { key: string; entries: NameCatalogEntry[] } => {
    const key = nameShardKey(nodeId);
    const row = state.get(KV.graphNameShards, key);
    return { key, entries: Array.isArray(row) ? (row as NameCatalogEntry[]) : [] };
  };
  for (const dup of dups) {
    const { key, entries } = shardOf(dup.id);
    state.set(KV.graphNameShards, key, entries.filter((e) => e.id !== dup.id));
    if (state.get(KV.graphNameIndex, nameIndexKey("file", dup.name)) === dup.id) {
      state.delete(KV.graphNameIndex, nameIndexKey("file", dup.name));
    }
    state.delete(KV.graphAdjacency, dup.id);
    state.delete(KV.graphNodeDegree, dup.id);
  }

  const renamed = survivor.name !== canonical;
  if (renamed) {
    const { key, entries } = shardOf(survivor.id);
    state.set(
      KV.graphNameShards,
      key,
      entries.map((e) => (e.id === survivor.id ? { ...e, name: canonical } : e)),
    );
    if (state.get(KV.graphNameIndex, nameIndexKey("file", survivor.name)) === survivor.id) {
      state.delete(KV.graphNameIndex, nameIndexKey("file", survivor.name));
    }
    patch.renamed.set(survivor.id, canonical);
  }
  state.set(KV.graphNameIndex, nameIndexKey("file", canonical), survivor.id);

  const sessionId = [...members].reverse().find((m) => m.sessionId)?.sessionId;
  const aliases = [...new Set(members.flatMap((m) => m.aliases ?? []))];
  state.set(KV.graphNodes, survivor.id, {
    ...survivor,
    name: canonical,
    properties: Object.assign({}, ...members.map((m) => m.properties)),
    sourceObservationIds: capSourceIds(members.flatMap((m) => m.sourceObservationIds ?? [])),
    ...(sessionId ? { sessionId } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    updatedAt: newest.updatedAt ?? newest.createdAt,
  });
  for (const dup of dups) state.delete(KV.graphNodes, dup.id);
  patch.removedNodes.push(...dups);

  for (const [nodeId, row] of adjacency) {
    if (dupIds.has(nodeId) || !row) continue;
    state.set(KV.graphAdjacency, nodeId, row);
  }
  for (const nodeId of touched) {
    if (dupIds.has(nodeId)) continue;
    const row = adjacencyOf(nodeId);
    if (row && state.get(KV.graphNodeDegree, nodeId) !== null) {
      state.set(KV.graphNodeDegree, nodeId, row.length);
    }
  }
}

/**
 * Folds file nodes that name one file by different paths into one node named
 * by its project-relative path: provenance unions under the write path's cap,
 * incident edges are re-pointed (an edge that becomes a self-loop is dropped, and
 * one that collides with an existing edge folds into it), and the side indexes
 * and snapshot follow. Each group commits in its own transaction, and a rerun
 * finds nothing left to merge.
 */
export async function mergeDuplicateFileNodes(
  state: SqliteState,
  roots: string[],
): Promise<FileNodeMergeResult> {
  const groups = groupsToMerge(state, roots);
  if (groups.length === 0) return { nodesMerged: 0, edgesChanged: 0 };

  const dupIds = new Set(
    groups.flatMap((g) => {
      const survivor = g.members.find((m) => m.name === g.canonical) ?? g.members[0]!;
      return g.members.filter((m) => m.id !== survivor.id).map((m) => m.id);
    }),
  );
  const edgeIdsByNode = edgesTouching(state, dupIds);
  const armed =
    (state.get(KV.graphIndexMeta, "current") as { version?: number } | null)?.version === 1;
  const patch: SnapshotPatch = {
    removedNodes: [],
    removedEdges: [],
    repointed: new Map(),
    renamed: new Map(),
  };

  for (let i = 0; i < groups.length; i += GROUPS_PER_TURN) {
    for (const group of groups.slice(i, i + GROUPS_PER_TURN)) {
      state.transaction(() => mergeGroup(state, group, edgeIdsByNode, patch, armed));
    }
    await yieldToEventLoop();
  }

  state.transaction(() => patchSnapshot(state, patch));
  noteGraphWrite(KV.graphNodes);
  return {
    nodesMerged: patch.removedNodes.length,
    edgesChanged: patch.repointed.size + patch.removedEdges.length,
  };
}
