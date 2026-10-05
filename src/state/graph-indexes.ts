import type { GraphNode, GraphEdge } from "../types.js";
import { KV } from "./schema.js";
import { graphWriteGeneration, type StateKV } from "./kv.js";
import { withKeyedLock } from "./keyed-mutex.js";
import { capSourceIds } from "../functions/graph-provenance.js";

export const NAME_SHARD_COUNT = 64;
export const GRAPH_INDEX_NODE_CEILING = 25000;
const META_KEY = "current";
const SNAPSHOT_KEY = "current";

export interface NameCatalogEntry {
  id: string;
  name: string;
}

export function nameShardKey(nodeId: string): string {
  let hash = 5381;
  for (let i = 0; i < nodeId.length; i++) {
    hash = ((hash * 33) ^ nodeId.charCodeAt(i)) >>> 0;
  }
  return String(hash % NAME_SHARD_COUNT);
}

export async function graphIndexesReady(kv: StateKV): Promise<boolean> {
  try {
    const meta = await kv.get<{ version?: number }>(KV.graphIndexMeta, META_KEY);
    return meta?.version === 1;
  } catch {
    return false;
  }
}

// Typed code returned by the graph read endpoints (graph-query, temporal,
// export, MCP graph resources) when the graph leg is unavailable, so callers
// get an explicit "unavailable" rather than a misleading success-with-empty.
export const GRAPH_INDEX_NOT_READY = "GRAPH_INDEX_NOT_READY";

// Kill-switch. AGENTMEMORY_GRAPH_LEG=off forces the fail-closed BM25+vector
// mode (B-mode): the graph leg makes ZERO graph-scope reads and skips ALL
// graph writes/maintenance (the graph is frozen). Read from the env on every
// call — not memoized at module load — so boot ordering and tests can flip it.
export function graphLegDisabled(): boolean {
  return process.env.AGENTMEMORY_GRAPH_LEG === "off";
}

// A graph READ is serviceable only when the leg is on AND the bounded
// side-indexes are armed. The unarmed reader path falls back to full
// kv.list(KV.graph*) enumeration, which overruns the engine's state-response
// budget and takes an uncatchable worker kill (the smart_search 500). So an
// unarmed graph is treated exactly like an off one: fail-closed, never
// enumerate. Callers that get `false` must degrade, not enumerate.
export async function graphReadable(kv: StateKV): Promise<boolean> {
  if (graphLegDisabled()) return false;
  return graphIndexesReady(kv);
}

export async function markGraphIndexesReady(kv: StateKV): Promise<void> {
  await kv.set(KV.graphIndexMeta, META_KEY, {
    version: 1,
    builtAt: new Date().toISOString(),
  });
}

export async function clearNameShards(kv: StateKV): Promise<void> {
  for (let shard = 0; shard < NAME_SHARD_COUNT; shard++) {
    await kv.delete(KV.graphNameShards, String(shard)).catch(() => {});
  }
}

const PAGE_SIZE = 200;

export async function* listPages<T>(
  kv: StateKV,
  scope: string,
): AsyncGenerator<T[]> {
  let after: string | undefined;
  for (;;) {
    const rows = await kv.listPage<T>(scope, after, PAGE_SIZE);
    if (rows.length === 0) return;
    yield rows.map((r) => r.value);
    after = rows[rows.length - 1].key;
  }
}

async function clearScope(kv: StateKV, scope: string): Promise<number> {
  let cleared = 0;
  for (;;) {
    const rows = await kv.listPage(scope, undefined, PAGE_SIZE);
    if (rows.length === 0) return cleared;
    await Promise.all(rows.map((r) => kv.delete(scope, r.key)));
    cleared += rows.length;
  }
}

export async function clearGraphSideIndexes(
  kv: StateKV,
): Promise<Record<string, number>> {
  await clearNameShards(kv);
  return {
    [KV.graphAdjacency]: await clearScope(kv, KV.graphAdjacency),
    [KV.graphObsNodes]: await clearScope(kv, KV.graphObsNodes),
  };
}

function groupInto<V>(
  groups: Map<string, V[]>,
  key: string,
  value: V,
): void {
  const list = groups.get(key);
  if (list) list.push(value);
  else groups.set(key, [value]);
}

export async function mergeGraphIndexPage(
  kv: StateKV,
  nodes: GraphNode[],
  edges: GraphEdge[],
): Promise<void> {
  const shards = new Map<string, NameCatalogEntry[]>();
  const obsNodes = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node?.id || typeof node.name !== "string") continue;
    groupInto(shards, nameShardKey(node.id), { id: node.id, name: node.name });
    for (const obsId of node.sourceObservationIds ?? []) {
      groupInto(obsNodes, obsId, node.id);
    }
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge?.id || !edge.sourceNodeId || !edge.targetNodeId) continue;
    groupInto(adjacency, edge.sourceNodeId, edge.id);
    if (edge.targetNodeId !== edge.sourceNodeId) {
      groupInto(adjacency, edge.targetNodeId, edge.id);
    }
  }

  for (const [shard, added] of shards) {
    await withKeyedLock(`gidx:shard:${shard}`, async () => {
      const entries =
        (await kv.get<NameCatalogEntry[]>(KV.graphNameShards, shard)) ?? [];
      const known = new Set(entries.map((e) => e.id));
      await kv.set(KV.graphNameShards, shard, [
        ...entries,
        ...added.filter((e) => !known.has(e.id)),
      ]);
    });
  }
  for (const [nodeId, edgeIds] of adjacency) {
    await withKeyedLock(`gidx:adj:${nodeId}`, async () => {
      const existing =
        (await kv.get<string[]>(KV.graphAdjacency, nodeId)) ?? [];
      await kv.set(KV.graphAdjacency, nodeId, [
        ...new Set([...existing, ...edgeIds]),
      ]);
    });
  }
  for (const [obsId, nodeIds] of obsNodes) {
    await withKeyedLock(`gidx:obs:${obsId}`, async () => {
      const existing = (await kv.get<string[]>(KV.graphObsNodes, obsId)) ?? [];
      await kv.set(
        KV.graphObsNodes,
        obsId,
        capSourceIds([...new Set([...existing, ...nodeIds])]),
      );
    });
  }
}

export async function indexGraphNode(
  kv: StateKV,
  node: GraphNode,
): Promise<void> {
  if (!node?.id || typeof node.name !== "string") return;
  const shard = nameShardKey(node.id);
  await withKeyedLock(`gidx:shard:${shard}`, async () => {
    const entries =
      (await kv.get<NameCatalogEntry[]>(KV.graphNameShards, shard)) ?? [];
    if (!entries.some((e) => e.id === node.id)) {
      entries.push({ id: node.id, name: node.name });
      await kv.set(KV.graphNameShards, shard, entries);
    }
  });
  await linkObservationsToNode(kv, node.id, node.sourceObservationIds);
}

export async function linkObservationsToNode(
  kv: StateKV,
  nodeId: string,
  obsIds: string[] | undefined,
): Promise<void> {
  for (const obsId of obsIds ?? []) {
    await withKeyedLock(`gidx:obs:${obsId}`, async () => {
      const nodeIds = (await kv.get<string[]>(KV.graphObsNodes, obsId)) ?? [];
      if (!nodeIds.includes(nodeId)) {
        await kv.set(
          KV.graphObsNodes,
          obsId,
          capSourceIds([...nodeIds, nodeId]),
        );
      }
    });
  }
}

export async function unlinkObservationNodes(
  kv: StateKV,
  obsId: string,
): Promise<void> {
  await withKeyedLock(`gidx:obs:${obsId}`, () =>
    kv.delete(KV.graphObsNodes, obsId),
  ).catch(() => {});
}

export async function indexGraphEdge(
  kv: StateKV,
  edge: GraphEdge,
): Promise<void> {
  if (!edge?.id || !edge.sourceNodeId || !edge.targetNodeId) return;
  const endpoints =
    edge.sourceNodeId === edge.targetNodeId
      ? [edge.sourceNodeId]
      : [edge.sourceNodeId, edge.targetNodeId];
  for (const nodeId of endpoints) {
    await withKeyedLock(`gidx:adj:${nodeId}`, async () => {
      const edgeIds = (await kv.get<string[]>(KV.graphAdjacency, nodeId)) ?? [];
      if (!edgeIds.includes(edge.id)) {
        edgeIds.push(edge.id);
        await kv.set(KV.graphAdjacency, nodeId, edgeIds);
      }
    });
  }
}

export async function loadNameCatalog(
  kv: StateKV,
): Promise<NameCatalogEntry[]> {
  const shards = await Promise.all(
    Array.from({ length: NAME_SHARD_COUNT }, (_, shard) =>
      kv
        .get<NameCatalogEntry[]>(KV.graphNameShards, String(shard))
        .catch(() => null),
    ),
  );
  const catalog: NameCatalogEntry[] = [];
  for (const entries of shards) {
    if (Array.isArray(entries)) catalog.push(...entries);
  }
  return catalog;
}

export async function loadAdjacentEdgeIds(
  kv: StateKV,
  nodeId: string,
): Promise<string[]> {
  const edgeIds = await kv
    .get<string[]>(KV.graphAdjacency, nodeId)
    .catch(() => null);
  return Array.isArray(edgeIds) ? edgeIds : [];
}

export async function loadNodeIdsForObservations(
  kv: StateKV,
  obsIds: string[],
): Promise<string[]> {
  const ids = new Set<string>();
  for (const obsId of obsIds) {
    const nodeIds = await kv
      .get<string[]>(KV.graphObsNodes, obsId)
      .catch(() => null);
    if (Array.isArray(nodeIds)) {
      for (const id of nodeIds) ids.add(id);
    }
  }
  return [...ids];
}

export async function readGraphResetAt(
  kv: StateKV,
): Promise<string | undefined> {
  try {
    const snap = await kv.get<{ resetAt?: string }>(
      KV.graphSnapshot,
      SNAPSHOT_KEY,
    );
    return snap?.resetAt;
  } catch {
    return undefined;
  }
}

export function isLiveGraphRecord(
  record: { stale?: boolean; createdAt?: string } | null | undefined,
  resetAt: string | undefined,
): boolean {
  if (!record || record.stale) return false;
  if (
    resetAt &&
    typeof record.createdAt === "string" &&
    record.createdAt < resetAt
  ) {
    return false;
  }
  return true;
}

export class GraphIndexReader {
  private nodeCache = new Map<string, GraphNode | null>();
  private edgeCache = new Map<string, GraphEdge | null>();

  private constructor(
    private kv: StateKV,
    private resetAt: string | undefined,
  ) {}

  static async open(kv: StateKV): Promise<GraphIndexReader> {
    return new GraphIndexReader(kv, await readGraphResetAt(kv));
  }

  async getNode(nodeId: string): Promise<GraphNode | null> {
    const cached = this.nodeCache.get(nodeId);
    if (cached !== undefined) return cached;
    const raw = await this.kv
      .get<GraphNode>(KV.graphNodes, nodeId)
      .catch(() => null);
    const node = isLiveGraphRecord(raw, this.resetAt) ? raw : null;
    this.nodeCache.set(nodeId, node);
    return node;
  }

  async getEdge(edgeId: string): Promise<GraphEdge | null> {
    const cached = this.edgeCache.get(edgeId);
    if (cached !== undefined) return cached;
    const raw = await this.kv
      .get<GraphEdge>(KV.graphEdges, edgeId)
      .catch(() => null);
    const edge = isLiveGraphRecord(raw, this.resetAt) ? raw : null;
    this.edgeCache.set(edgeId, edge);
    return edge;
  }

  async getIncidentEdges(nodeId: string): Promise<GraphEdge[]> {
    const edgeIds = await loadAdjacentEdgeIds(this.kv, nodeId);
    const edges: GraphEdge[] = [];
    for (const edgeId of edgeIds) {
      const edge = await this.getEdge(edgeId);
      if (edge) edges.push(edge);
    }
    return edges;
  }

  async getNeighbors(
    nodeId: string,
  ): Promise<Array<{ node: GraphNode; edge: GraphEdge }>> {
    const neighbors: Array<{ node: GraphNode; edge: GraphEdge }> = [];
    for (const edge of await this.getIncidentEdges(nodeId)) {
      const neighborId =
        edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
      const node = await this.getNode(neighborId);
      if (node) neighbors.push({ node, edge });
    }
    return neighbors;
  }
}

export interface GraphReadView {
  reader: GraphIndexReader;
  loadCatalog(): Promise<NameCatalogEntry[]>;
}

interface CachedGraphReadView {
  generation: number;
  reader: Promise<GraphIndexReader>;
  catalog?: Promise<NameCatalogEntry[]>;
}

const readViews = new WeakMap<object, CachedGraphReadView>();

// One reader and name catalog per store, rebuilt whenever any graph scope is
// written, so a search stops re-reading the 64 name shards and re-fetching
// nodes it just read. The reader's record caches would otherwise go stale.
export async function openGraphReadView(kv: StateKV): Promise<GraphReadView> {
  const generation = graphWriteGeneration();
  let cached = readViews.get(kv);
  if (!cached || cached.generation !== generation) {
    cached = { generation, reader: GraphIndexReader.open(kv) };
    readViews.set(kv, cached);
  }
  const entry = cached;
  const reader = await entry.reader.catch((err) => {
    if (readViews.get(kv) === entry) readViews.delete(kv);
    throw err;
  });
  return {
    reader,
    loadCatalog: () => {
      entry.catalog ??= loadNameCatalog(kv).catch((err) => {
        entry.catalog = undefined;
        throw err;
      });
      return entry.catalog;
    },
  };
}

// A bounded snapshot of live nodes and the edges incident to them, read
// through the indexes. Empty while the graph is unreadable. The limit counts
// only nodes that pass keep, so a filter applied here cannot be starved by
// nodes it would have dropped; a narrow keep may read every catalog node to
// fill it.
export async function readBoundedGraphSnapshot(
  kv: StateKV,
  nodeLimit: number,
  keep: (node: GraphNode) => boolean = () => true,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  if (!(await graphReadable(kv))) return { nodes: [], edges: [] };
  const { reader, loadCatalog } = await openGraphReadView(kv);
  const catalog = [...(await loadCatalog())].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const nodes: GraphNode[] = [];
  const edges = new Map<string, GraphEdge>();
  for (const entry of catalog) {
    if (nodes.length >= nodeLimit) break;
    const node = await reader.getNode(entry.id);
    if (!node || !keep(node)) continue;
    nodes.push(node);
    for (const edge of await reader.getIncidentEdges(node.id)) {
      edges.set(edge.id, edge);
    }
  }
  return { nodes, edges: [...edges.values()] };
}

export async function backfillGraphIndexes(
  kv: StateKV,
  nodes: GraphNode[],
  edges: GraphEdge[],
): Promise<void> {
  const shards = new Map<string, NameCatalogEntry[]>();
  const obsNodes = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node?.id || typeof node.name !== "string") continue;
    const shard = nameShardKey(node.id);
    const entries = shards.get(shard) ?? [];
    entries.push({ id: node.id, name: node.name });
    shards.set(shard, entries);
    for (const obsId of node.sourceObservationIds ?? []) {
      const linked = obsNodes.get(obsId) ?? [];
      if (!linked.includes(node.id)) {
        linked.push(node.id);
        obsNodes.set(obsId, linked);
      }
    }
  }

  const adjacency = new Map<string, string[]>();
  const appendEdge = (nodeId: string, edgeId: string): void => {
    const list = adjacency.get(nodeId) ?? [];
    if (!list.includes(edgeId)) {
      list.push(edgeId);
      adjacency.set(nodeId, list);
    }
  };
  for (const edge of edges) {
    if (!edge?.id || !edge.sourceNodeId || !edge.targetNodeId) continue;
    appendEdge(edge.sourceNodeId, edge.id);
    if (edge.targetNodeId !== edge.sourceNodeId) {
      appendEdge(edge.targetNodeId, edge.id);
    }
  }

  for (let shard = 0; shard < NAME_SHARD_COUNT; shard++) {
    const key = String(shard);
    await kv.set(KV.graphNameShards, key, shards.get(key) ?? []);
  }

  const BATCH_SIZE = 100;
  const adjacencyEntries = [...adjacency.entries()];
  for (let i = 0; i < adjacencyEntries.length; i += BATCH_SIZE) {
    await Promise.all(
      adjacencyEntries
        .slice(i, i + BATCH_SIZE)
        .map(([nodeId, edgeIds]) => kv.set(KV.graphAdjacency, nodeId, edgeIds)),
    );
  }
  const obsEntries = [...obsNodes.entries()];
  for (let i = 0; i < obsEntries.length; i += BATCH_SIZE) {
    await Promise.all(
      obsEntries
        .slice(i, i + BATCH_SIZE)
        .map(([obsId, nodeIds]) =>
          kv.set(KV.graphObsNodes, obsId, capSourceIds(nodeIds)),
        ),
    );
  }

  await markGraphIndexesReady(kv);
}
