import type { ISdk } from "../engine/types.js";
import type {
  GraphNode,
  GraphEdge,
  GraphQueryResult,
  GraphSnapshot,
  SnapshotNode,
  SnapshotEdge,
  CompressedObservation,
  MemoryProvider,
  Session,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type { StateKV } from "../state/kv.js";
import {
  GraphIndexReader,
  clearGraphSideIndexes,
  graphLegDisabled,
  graphReadable,
  indexGraphEdge,
  indexGraphNode,
  linkObservationsToNode,
  listPages,
  loadNameCatalog,
  markGraphIndexesReady,
  mergeGraphIndexPage,
} from "../state/graph-indexes.js";
import {
  GRAPH_EXTRACTION_SYSTEM,
  buildGraphExtractionPrompt,
} from "../prompts/graph-extraction.js";
import { getGraphBatchSize, isGraphExtractionEnabled } from "../config.js";
import { isNoopProvider } from "../providers/noop.js";
import { capSourceIds } from "./graph-provenance.js";
import { withProjectRelativeFiles } from "./project-files.js";
import { recordAudit } from "./audit.js";
import { getSearchIndex } from "./search.js";
import { logger } from "../logger.js";

// #753: keep the response payload small enough to serialize and render.
// 500 nodes + their incident edges stay small on the reported
// 11k-node / 28k-edge corpus, and 5,000 is the upper bound a
// caller can request explicitly. Tuned conservatively because edges
// fan out faster than nodes.
const DEFAULT_GRAPH_QUERY_LIMIT = 500;
const MAX_GRAPH_QUERY_LIMIT = 5000;

// #814: the precomputed snapshot covers the top-degree subgraph used by
// the empty-body / nodeType-only branch — the path the viewer hits on
// tab load. Sized to match the default query limit so the snapshot can
// service a default-cap request without falling back to live
// enumeration. Aggregate stats (nodesByType / edgesByType) are computed
// fresh during rebuild and stored alongside.
const SNAPSHOT_TOP_NODES = DEFAULT_GRAPH_QUERY_LIMIT;
const SNAPSHOT_KEY = "current";

// #1171: the snapshot is derived and disposable, so it holds a projection of
// each node and edge with provenance stripped. Origin is read from the record.
function stripProvenance<T extends SnapshotNode | SnapshotEdge>(
  record: T & { sourceObservationIds?: string[] },
): Omit<T, "sourceObservationIds"> {
  const { sourceObservationIds: _drop, ...rest } = record;
  return rest;
}

function emptySnapshot(): GraphSnapshot {
  return {
    version: 1,
    topNodes: [],
    topEdges: [],
    topDegrees: {},
    stats: {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
    },
    updatedAt: new Date(0).toISOString(),
    dirty: true,
  };
}

// Absence is not failure. A missing or unreadable-shaped snapshot returns
// null and the caller treats the graph as empty; a store error propagates,
// so a write path can tell the two apart (#1169).
async function loadSnapshot(kv: StateKV): Promise<GraphSnapshot | null> {
  const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, SNAPSHOT_KEY);
  if (snap && typeof snap === "object" && snap.version === 1) {
    return snap;
  }
  return null;
}

async function readSnapshot(kv: StateKV): Promise<GraphSnapshot | null> {
  try {
    return await loadSnapshot(kv);
  } catch (err) {
    logger.warn("Graph snapshot read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function rebuildIndexesAndSnapshot(kv: StateKV): Promise<GraphSnapshot> {
  await clearGraphSideIndexes(kv);

  const degree = new Map<string, number>();
  const edgesByType: Record<string, number> = {};
  let totalEdges = 0;
  for await (const page of listPages<GraphEdge>(kv, KV.graphEdges)) {
    const live = page.filter((e) => !e.stale);
    for (const e of live) {
      degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
      degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
      edgesByType[e.type] = (edgesByType[e.type] || 0) + 1;
    }
    totalEdges += live.length;
    await Promise.all(
      live.map((e) =>
        kv.set(
          KV.graphEdgeKey,
          edgeIndexKey(e.sourceNodeId, e.targetNodeId, e.type),
          e.id,
        ),
      ),
    );
    await mergeGraphIndexPage(kv, [], live);
  }

  const nodesByType: Record<string, number> = {};
  let totalNodes = 0;
  let ranked: GraphNode[] = [];
  for await (const page of listPages<GraphNode>(kv, KV.graphNodes)) {
    const live = page.filter((n) => !n.stale);
    for (const n of live) nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
    totalNodes += live.length;
    await Promise.all(
      live.flatMap((n) => [
        kv.set(KV.graphNameIndex, nameIndexKey(n.type, n.name), n.id),
        kv.set(KV.graphNodeDegree, n.id, degree.get(n.id) ?? 0),
      ]),
    );
    await mergeGraphIndexPage(kv, live, []);
    ranked = [...ranked, ...live]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, SNAPSHOT_TOP_NODES);
  }
  await markGraphIndexesReady(kv);

  const rankedIds = new Set(ranked.map((n) => n.id));
  const topEdges: GraphEdge[] = [];
  for await (const page of listPages<GraphEdge>(kv, KV.graphEdges)) {
    for (const e of page) {
      if (
        !e.stale &&
        rankedIds.has(e.sourceNodeId) &&
        rankedIds.has(e.targetNodeId)
      ) {
        topEdges.push(e);
      }
    }
  }
  const topDegrees: Record<string, number> = {};
  for (const n of ranked) topDegrees[n.id] = degree.get(n.id) ?? 0;
  return {
    version: 1,
    topNodes: ranked.map(stripProvenance),
    topEdges: topEdges.map(stripProvenance),
    topDegrees,
    stats: { totalNodes, totalEdges, nodesByType, edgesByType },
    updatedAt: new Date().toISOString(),
    dirty: false,
  };
}

function paginateFromSnapshot(
  snap: GraphSnapshot,
  filterType: string | undefined,
  limit: number,
  offset: number,
): GraphQueryResult {
  const filteredNodes = filterType
    ? snap.topNodes.filter((n) => n.type === filterType)
    : snap.topNodes;
  const total = Math.max(
    filterType ? snap.stats.nodesByType[filterType] ?? 0 : snap.stats.totalNodes,
    filteredNodes.length,
  );
  const pageNodes = filteredNodes.slice(offset, offset + limit);
  const pageIds = new Set(pageNodes.map((n) => n.id));
  const pageEdges = snap.topEdges.filter(
    (e) => pageIds.has(e.sourceNodeId) && pageIds.has(e.targetNodeId),
  );
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth: 0,
    totalNodes: total,
    totalEdges: snap.stats.totalEdges,
    truncated: total > pageNodes.length,
    limit,
    offset,
    fromSnapshot: true,
  };
}

// Bounds the index-served BFS in mem::graph-query so a dense corpus
// can't expand into an unbounded number of targeted gets. Hitting the
// cap returns a truncated page with an explanatory warning.
const TRAVERSAL_VISIT_CAP = 5000;

async function queryViaIndexes(
  kv: StateKV,
  query: string,
  limit: number,
  offset: number,
): Promise<GraphQueryResult> {
  const reader = await GraphIndexReader.open(kv);
  const lower = query.toLowerCase();
  const catalog = await loadNameCatalog(kv);
  // Mixed on purpose: name matches come from the records and carry
  // provenance, property matches come from the snapshot and do not (#1171).
  const matched = new Map<string, SnapshotNode>();
  for (const entry of catalog) {
    if (!entry.name.toLowerCase().includes(lower)) continue;
    const node = await reader.getNode(entry.id);
    if (node) matched.set(node.id, node);
  }

  const snap = await readSnapshot(kv);
  let partialPropertyCoverage = false;
  for (const node of snap?.topNodes ?? []) {
    if (node.stale || matched.has(node.id)) continue;
    const propMatch = Object.values(node.properties).some(
      (v) => typeof v === "string" && v.toLowerCase().includes(lower),
    );
    if (propMatch) matched.set(node.id, node);
  }
  if (!snap || snap.stats.totalNodes > snap.topNodes.length) {
    partialPropertyCoverage = true;
  }

  const nodes = [...matched.values()];
  const edgeIds = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    for (const edge of await reader.getIncidentEdges(node.id)) {
      if (edgeIds.has(edge.id)) continue;
      edgeIds.add(edge.id);
      edges.push(edge);
    }
  }

  const result = paginate(nodes, edges, 0, limit, offset);
  if (partialPropertyCoverage) {
    return {
      ...result,
      warning:
        "Property-value matches are served from the top-degree snapshot; " +
        "nodes outside it are matched by name only.",
    };
  }
  return result;
}

async function traverseViaIndexes(
  kv: StateKV,
  startNodeId: string,
  nodeType: string | undefined,
  maxDepth: number,
  limit: number,
  offset: number,
): Promise<GraphQueryResult> {
  const reader = await GraphIndexReader.open(kv);
  const visited = new Set<string>();
  const visitedEdges = new Set<string>();
  const resultNodes: GraphNode[] = [];
  const resultEdges: GraphEdge[] = [];
  const queue: Array<{ nodeId: string; depth: number }> = [
    { nodeId: startNodeId, depth: 0 },
  ];
  let capped = false;

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!;
    if (visited.has(nodeId) || depth > maxDepth) continue;
    if (visited.size >= TRAVERSAL_VISIT_CAP) {
      capped = true;
      break;
    }
    visited.add(nodeId);

    const node = await reader.getNode(nodeId);
    if (node && (!nodeType || node.type === nodeType)) {
      resultNodes.push(node);
    }

    for (const edge of await reader.getIncidentEdges(nodeId)) {
      if (!visitedEdges.has(edge.id)) {
        visitedEdges.add(edge.id);
        resultEdges.push(edge);
      }
      const nextId =
        edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
      if (!visited.has(nextId)) {
        queue.push({ nodeId: nextId, depth: depth + 1 });
      }
    }
  }

  const result = paginate(resultNodes, resultEdges, maxDepth, limit, offset);
  if (capped) {
    return {
      ...result,
      truncated: true,
      warning:
        `Traversal stopped after visiting ${TRAVERSAL_VISIT_CAP} nodes. ` +
        `Lower maxDepth or start from a lower-degree node for a complete walk.`,
    };
  }
  return result;
}

function nameIndexKey(type: string, name: string): string {
  return `${type}|${name}`;
}

function edgeIndexKey(
  sourceNodeId: string,
  targetNodeId: string,
  type: string,
): string {
  return `${sourceNodeId}|${targetNodeId}|${type}`;
}

// Mutates `snap` to apply a +1 (or -1) degree delta for nodeId,
// maintaining the top-N ranking. Returns the new degree. Reads /
// writes the per-node degree counter via targeted kv.get/set so we
// never enumerate. Top-N membership flips when:
//   - node's new degree > current min in topNodes AND it's not in
//     topNodes (promote, evict tail if topNodes is full)
//   - node IS in topNodes and its position needs resorting (re-sort
//     topNodes in place)
async function applyDegreeDelta(
  kv: StateKV,
  snap: GraphSnapshot,
  nodeId: string,
  delta: number,
): Promise<number> {
  const prev = (await kv.get<number>(KV.graphNodeDegree, nodeId)) ?? 0;
  const next = Math.max(0, prev + delta);
  await kv.set(KV.graphNodeDegree, nodeId, next);

  const inTop = snap.topNodes.findIndex((n) => n.id === nodeId);
  if (inTop !== -1) {
    // Cache the new degree in topDegrees so the comparator runs
    // synchronously over numbers, not async kv.get calls. Re-sort
    // descending by degree.
    snap.topDegrees[nodeId] = next;
    snap.topNodes.sort(
      (a, b) =>
        (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
    );
    return next;
  }

  if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
    // Capacity available — fetch + promote.
    const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
    if (node && !node.stale) {
      snap.topNodes.push(stripProvenance(node));
      snap.topDegrees[node.id] = next;
      snap.topNodes.sort(
        (a, b) =>
          (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
      );
    }
    return next;
  }

  // topNodes is full; the cutoff is the tail's cached degree.
  const tailEntry = snap.topNodes[snap.topNodes.length - 1];
  if (!tailEntry) return next;
  const tailDegree = snap.topDegrees[tailEntry.id] ?? 0;
  if (next > tailDegree) {
    const node = await kv.get<GraphNode>(KV.graphNodes, nodeId);
    if (node && !node.stale) {
      const evicted = snap.topNodes.pop();
      if (evicted) delete snap.topDegrees[evicted.id];
      snap.topNodes.push(stripProvenance(node));
      snap.topDegrees[node.id] = next;
      snap.topNodes.sort(
        (a, b) =>
          (snap.topDegrees[b.id] ?? 0) - (snap.topDegrees[a.id] ?? 0),
      );
    }
  }
  return next;
}

function snapshotPushEdgeIfBothInTop(
  snap: GraphSnapshot,
  edge: GraphEdge,
): void {
  const topIds = new Set(snap.topNodes.map((n) => n.id));
  if (topIds.has(edge.sourceNodeId) && topIds.has(edge.targetNodeId)) {
    // Dedupe in case the same edge gets pushed twice.
    if (!snap.topEdges.find((e) => e.id === edge.id)) {
      snap.topEdges.push(stripProvenance(edge));
    }
  }
}

function mergeNode(
  existing: GraphNode,
  incoming: GraphNode,
  obsIds: string[],
  capturedAt: string,
): GraphNode {
  return {
    ...existing,
    sourceObservationIds: capSourceIds([
      ...existing.sourceObservationIds,
      ...incoming.sourceObservationIds,
      ...obsIds,
    ]),
    properties: { ...existing.properties, ...incoming.properties },
    // Refresh to the newest source's session (#656). The incoming node
    // is the more recent extract; prefer its sessionId when present so a
    // node re-observed in a different session points at the live one.
    // Falls back to the existing value (which may itself be undefined for
    // pre-#656 nodes — retrieval handles that case).
    sessionId: incoming.sessionId ?? existing.sessionId,
    updatedAt: capturedAt,
  };
}

function mergeEdge(
  existing: GraphEdge,
  obsIds: string[],
): GraphEdge {
  return {
    ...existing,
    sourceObservationIds: capSourceIds([...existing.sourceObservationIds, ...obsIds]),
  };
}

function resolvePagination(
  rawLimit: number | undefined,
  rawOffset: number | undefined,
): { limit: number; offset: number } {
  const requested = typeof rawLimit === "number" && Number.isFinite(rawLimit)
    ? Math.floor(rawLimit)
    : DEFAULT_GRAPH_QUERY_LIMIT;
  const limit = Math.max(1, Math.min(requested, MAX_GRAPH_QUERY_LIMIT));
  const offset = Math.max(
    0,
    typeof rawOffset === "number" && Number.isFinite(rawOffset)
      ? Math.floor(rawOffset)
      : 0,
  );
  return { limit, offset };
}

function paginate(
  nodes: SnapshotNode[],
  allEdges: SnapshotEdge[],
  depth: number,
  limit: number,
  offset: number,
): GraphQueryResult {
  const totalNodes = nodes.length;
  const pageNodes = nodes.slice(offset, offset + limit);
  const pageNodeIds = new Set(pageNodes.map((n) => n.id));
  // Edges restricted to the page so the response payload scales with
  // `limit`, not with the global edge count. An edge is included only
  // when BOTH endpoints land in the page — half-edges to nodes outside
  // the page would render as dangling links in the viewer.
  const pageEdges = allEdges.filter(
    (e) => pageNodeIds.has(e.sourceNodeId) && pageNodeIds.has(e.targetNodeId),
  );
  // Total edges (for the same node universe). Counted unbounded so the
  // viewer can show "showing X of Y" without re-querying.
  const universeIds = new Set(nodes.map((n) => n.id));
  const totalEdges = allEdges.reduce(
    (count, e) =>
      universeIds.has(e.sourceNodeId) && universeIds.has(e.targetNodeId)
        ? count + 1
        : count,
    0,
  );
  return {
    nodes: pageNodes,
    edges: pageEdges,
    depth,
    totalNodes,
    totalEdges,
    truncated: totalNodes > pageNodes.length,
    limit,
    offset,
  };
}

// Parse all key="value" pairs from a tag's attribute string, in any
// order. The previous parser hard-coded attribute order
// (type before name on <entity>, type/source/target/weight on
// <relationship>) and silently dropped nodes/edges when the upstream
// LLM emitted attributes in a different order — Codex in particular
// likes to lead with `name=` (#635).
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([A-Za-z_][\w:-]*)="([^"]*)"/g;
  let m;
  while ((m = attrRegex.exec(raw)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

export const MAX_OBSERVATION_CONCEPTS = 10;

// What Extraction learned about one Observation: the importance the model gave
// it and the names of the non-file Entities it says came from it.
interface ObservationAnnotation {
  importance?: number;
  concepts: string[];
}

function parseGraphXml(
  xml: string,
  observationIds: string[],
  // obsId -> sessionId, so each extracted node can record the session
  // namespace of its source observations (#656). Optional: when omitted
  // (or an obsId is missing), the node's sessionId is left undefined and
  // retrieval falls back to a cross-session scan.
  sessionByObsId?: Map<string, string>,
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const now = new Date().toISOString();

  // Two passes because <entity> can be self-closing or have a body
  // (<property> children). The self-closing form needs `[^>]*[^/]` on
  // the attr group so the trailing `/` isn't swallowed into the match
  // (root cause of #494). The explicit-close form picks up the
  // property block.
  const entitySelfClose = /<entity\b([^>]*?)\/>/g;
  const entityWithBody = /<entity\b([^>]*[^/])>([\s\S]*?)<\/entity>/g;

  const addEntity = (rawAttrs: string, propsBlock = ""): void => {
    const attrs = parseAttrs(rawAttrs);
    const type = attrs["type"] as GraphNode["type"] | undefined;
    const name = attrs["name"];
    if (!type || !name) return;
    const properties: Record<string, string> = {};
    const propRegex = /<property\s+key="([^"]+)">([^<]*)<\/property>/g;
    let propMatch;
    while ((propMatch = propRegex.exec(propsBlock)) !== null) {
      properties[propMatch[1]] = propMatch[2];
    }
    // Resolve the node's sessionId from its source observations. All
    // observationIds in one extract call share the batch, so the first
    // resolvable session is representative; merges later refresh it to
    // the newest source (see mergeNode).
    let sessionId: string | undefined;
    if (sessionByObsId) {
      for (const obsId of observationIds) {
        const sid = sessionByObsId.get(obsId);
        if (sid) {
          sessionId = sid;
          break;
        }
      }
    }
    nodes.push({
      id: generateId("gn"),
      type,
      name,
      properties,
      sourceObservationIds: capSourceIds(observationIds),
      ...(sessionId !== undefined && { sessionId }),
      createdAt: now,
    });
  };

  let match;
  while ((match = entitySelfClose.exec(xml)) !== null) {
    addEntity(match[1]);
  }
  while ((match = entityWithBody.exec(xml)) !== null) {
    addEntity(match[1], match[2]);
  }

  const relRegex = /<relationship\b([^>]*?)\/>/g;
  while ((match = relRegex.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1]);
    const type = attrs["type"] as GraphEdge["type"] | undefined;
    const sourceName = attrs["source"];
    const targetName = attrs["target"];
    if (!type || !sourceName || !targetName) continue;
    const parsedWeight = parseFloat(attrs["weight"] ?? "");
    const weight = Number.isFinite(parsedWeight) ? parsedWeight : 0.5;

    const sourceNode = nodes.find((n) => n.name === sourceName);
    const targetNode = nodes.find((n) => n.name === targetName);
    if (!sourceNode || !targetNode) continue;
    edges.push({
      id: generateId("ge"),
      type,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      weight: Math.max(0, Math.min(1, weight)),
      sourceObservationIds: capSourceIds(observationIds),
      createdAt: now,
    });
  }

  return { nodes, edges };
}

// Observations are named by their 1-based number in the batch prompt, so an
// importance or an Entity's obs="" list maps back through observationIds.
function parseObservationAnnotations(
  xml: string,
  observationIds: string[],
): Map<string, ObservationAnnotation> {
  const annotations = new Map<string, ObservationAnnotation>();
  const ensureAnnotation = (n: string): ObservationAnnotation | undefined => {
    if (!/^\d+$/.test(n.trim())) return undefined;
    const obsId = observationIds[Number(n) - 1];
    if (!obsId) return undefined;
    let annotation = annotations.get(obsId);
    if (!annotation) {
      annotation = { concepts: [] };
      annotations.set(obsId, annotation);
    }
    return annotation;
  };

  let match;
  const observationRegex = /<observation\b([^>]*?)\/>/g;
  while ((match = observationRegex.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1]);
    const importance = Number(attrs["importance"]);
    if (!Number.isInteger(importance) || importance < 1 || importance > 10) continue;
    const annotation = ensureAnnotation(attrs["n"] ?? "");
    if (annotation) annotation.importance = importance;
  }
  const entityOpenTag = /<entity\b([^>]*?)\/?>/g;
  while ((match = entityOpenTag.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1]);
    const name = attrs["name"];
    if (!attrs["type"] || attrs["type"] === "file" || !name) continue;
    for (const n of (attrs["obs"] ?? "").split(",")) {
      ensureAnnotation(n)?.concepts.push(name);
    }
  }
  return annotations;
}

// Field-level, so a concurrent writer's other fields survive. An Observation
// gone from KV is skipped: update() would recreate it as a bare stub. Failures
// are logged, not thrown: the graph is already written by then.
async function writeObservationAnnotations(
  kv: StateKV,
  observations: CompressedObservation[],
  annotations: Map<string, ObservationAnnotation>,
): Promise<void> {
  const index = getSearchIndex();
  const results = await Promise.allSettled(
    observations.map(async (o) => {
      const annotation = annotations.get(o.id);
      if (!annotation || !o.sessionId) return;
      const scope = KV.observations(o.sessionId);
      const current = await kv.get<CompressedObservation>(scope, o.id);
      if (!current) return;
      const fields: Pick<CompressedObservation, "importance" | "concepts"> = {
        importance: annotation.importance ?? current.importance,
        concepts: [...new Set([...(current.concepts ?? []), ...annotation.concepts])].slice(
          0,
          MAX_OBSERVATION_CONCEPTS,
        ),
      };
      await kv.update(
        scope,
        o.id,
        Object.entries(fields).map(([path, value]) => ({ type: "set", path, value })),
      );
      if (index.has(o.id)) index.add({ ...current, ...fields });
    }),
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    logger.warn("Observation importance write-back failed", {
      failed: failed.length,
      error: String((failed[0] as PromiseRejectedResult).reason),
    });
  }
}

const HEURISTIC_EDGE_WEIGHT = 0.4;
const MAX_HEURISTIC_EDGES_PER_OBS = 12;

export function extractGraphHeuristics(
  observations: CompressedObservation[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const now = new Date().toISOString();
  const nodes: GraphNode[] = [];
  const nodeByKey = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeByPair = new Map<string, GraphEdge>();

  const nodeFor = (
    type: GraphNode["type"],
    name: string,
    obsId: string,
  ): GraphNode | null => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const key = `${type}\u001f${trimmed.toLowerCase()}`;
    let node = nodeByKey.get(key);
    if (!node) {
      node = {
        id: generateId("gn"),
        type,
        name: trimmed,
        properties: {},
        sourceObservationIds: [obsId],
        createdAt: now,
      };
      nodeByKey.set(key, node);
      nodes.push(node);
    } else if (!node.sourceObservationIds.includes(obsId)) {
      node.sourceObservationIds = capSourceIds([
        ...node.sourceObservationIds,
        obsId,
      ]);
    }
    return node;
  };

  for (const obs of observations) {
    let budget = MAX_HEURISTIC_EDGES_PER_OBS;
    const link = (a: GraphNode | null, b: GraphNode | null): void => {
      if (!a || !b || a.id === b.id) return;
      const pair = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      const existing = edgeByPair.get(pair);
      if (existing) {
        if (!existing.sourceObservationIds.includes(obs.id)) {
          existing.sourceObservationIds = capSourceIds([
            ...existing.sourceObservationIds,
            obs.id,
          ]);
        }
        return;
      }
      if (budget <= 0) return;
      budget -= 1;
      const edge: GraphEdge = {
        id: generateId("ge"),
        type: "related_to",
        sourceNodeId: a.id,
        targetNodeId: b.id,
        weight: HEURISTIC_EDGE_WEIGHT,
        sourceObservationIds: [obs.id],
        createdAt: now,
      };
      edgeByPair.set(pair, edge);
      edges.push(edge);
    };

    const fileNodes = (obs.files ?? []).map((f) =>
      nodeFor("file", f, obs.id),
    );
    const conceptNodes = (obs.concepts ?? []).map((c) =>
      nodeFor("concept", c, obs.id),
    );

    for (const concept of conceptNodes) {
      for (const file of fileNodes) link(concept, file);
    }
    for (let i = 0; i + 1 < conceptNodes.length; i++) {
      link(conceptNodes[i], conceptNodes[i + 1]);
    }
    for (let i = 0; i + 1 < fileNodes.length; i++) {
      link(fileNodes[i], fileNodes[i + 1]);
    }
  }

  return { nodes, edges };
}

// Shared persistence for a batch of extracted/imported nodes and edges.
// Factored out of mem::graph-extract so structural importers (graphify)
// reuse the exact same name-index upsert, degree bookkeeping, and snapshot
// maintenance — which also makes re-imports idempotent: an existing
// (type, name) resolves through the name index and merges instead of
// duplicating.
//
// #814 v2: targeted name-index lookups replace the O(n) scan over
// `kv.list<GraphNode>(KV.graphNodes)`, which blocks the event loop for the
// whole scope on every extract. Each name-index entry is a single small
// kv.get/set pair.
// Fork posture (graph-off): a graph WRITE is allowed only when extraction is
// armed (GRAPH_EXTRACTION_ENABLED) AND the graph leg is not killed
// (AGENTMEMORY_GRAPH_LEG=off). Stock 0.9.29 writes heuristic nodes with no
// flag at all; both 0.9.29 writers (graph-extract, graphify import) funnel
// through persistGraphDelta, and the one path that bypasses it (mem::import in
// export-import.ts) applies this same predicate itself. Lives here rather
// than in graph-indexes.ts so config.ts stays out of that module's import
// graph (several tests partially mock it).
export function graphWritesDisabled(): boolean {
  return graphWritesOffReason() !== null;
}

export function graphWritesOffReason(): string | null {
  const reasons: string[] = [];
  if (!isGraphExtractionEnabled()) reasons.push("GRAPH_EXTRACTION_ENABLED is not true");
  if (graphLegDisabled()) reasons.push("AGENTMEMORY_GRAPH_LEG=off");
  return reasons.length > 0 ? reasons.join(", ") : null;
}

const GRAPH_WRITE_LOCK = "mem:graph:write";

export function persistGraphDelta(
  kv: StateKV,
  nodes: GraphNode[],
  edges: GraphEdge[],
  obsIds: string[],
): Promise<{ newNodeCount: number; newEdgeCount: number }> {
  return withKeyedLock(GRAPH_WRITE_LOCK, () =>
    persistGraphDeltaUnlocked(kv, nodes, edges, obsIds),
  );
}

async function persistGraphDeltaUnlocked(
  kv: StateKV,
  nodes: GraphNode[],
  edges: GraphEdge[],
  obsIds: string[],
): Promise<{ newNodeCount: number; newEdgeCount: number }> {
  if (graphWritesDisabled()) return { newNodeCount: 0, newEdgeCount: 0 };
  // A snapshot we cannot read is not an empty graph. Writing on top of that
  // assumption overwrites the stored snapshot with an empty view and zeroes
  // its statistics, so abort the batch before its first write and leave the
  // stored snapshot alone. The batch is lost, not retried in place: a
  // persistent store fault must not spin (#1169).
  let snap: GraphSnapshot;
  try {
    snap = (await loadSnapshot(kv)) ?? emptySnapshot();
  } catch (err) {
    logger.warn("Graph snapshot read failed; skipping graph write for this batch", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { newNodeCount: 0, newEdgeCount: 0 };
  }
  const capturedAt = new Date().toISOString();
  let newNodeCount = 0;
  let newEdgeCount = 0;
  // Merge-only batches mutate cached topNodes/topEdges entries without
  // changing the counts; track that separately so the snapshot still persists.
  let snapMutated = false;
  const newEdgesForTopCheck: GraphEdge[] = [];
  // When a freshly-minted node merges into an existing row via the name
  // index, edges in the same batch still reference the fresh id. Remap edge
  // endpoints to the persisted ids so edges never dangle and re-runs hit the
  // same edge-index key instead of duplicating.
  const idRemap = new Map<string, string>();

  for (const node of nodes) {
    const indexKey = nameIndexKey(node.type, node.name);
    const existingId = await kv.get<string>(KV.graphNameIndex, indexKey);

    let existing: GraphNode | null = null;
    if (existingId) {
      existing = await kv.get<GraphNode>(KV.graphNodes, existingId);
      // #825 follow-up: name-index lookups can resolve into
      // pre-reset rows. Drop them so extract writes a fresh
      // node + index entry instead of silently reconnecting
      // to a legacy orphan (which would keep the snapshot at
      // 0 forever after a reset).
      if (
        existing &&
        snap.resetAt &&
        typeof existing.createdAt === "string" &&
        existing.createdAt < snap.resetAt
      ) {
        existing = null;
      }
    }

    if (existing) {
      idRemap.set(node.id, existing.id);
      const merged = mergeNode(existing, node, obsIds, capturedAt);
      await kv.set(KV.graphNodes, existing.id, merged);
      await linkObservationsToNode(kv, existing.id, obsIds);
      // Update topNodes entry if present so a stale clone isn't
      // returned from the snapshot fast path.
      const topIdx = snap.topNodes.findIndex((n) => n.id === existing!.id);
      if (topIdx !== -1) {
        snap.topNodes[topIdx] = stripProvenance(merged);
        snapMutated = true;
      }
    } else {
      await kv.set(KV.graphNodes, node.id, node);
      await kv.set(KV.graphNameIndex, indexKey, node.id);
      await kv.set(KV.graphNodeDegree, node.id, 0);
      await indexGraphNode(kv, node);
      snap.stats.totalNodes += 1;
      snap.stats.nodesByType[node.type] =
        (snap.stats.nodesByType[node.type] ?? 0) + 1;
      newNodeCount += 1;
      if (snap.topNodes.length < SNAPSHOT_TOP_NODES) {
        // Degree 0 still beats an empty slot — sit at the tail
        // until edges arrive and promote.
        snap.topNodes.push(stripProvenance(node));
        snap.topDegrees[node.id] = 0;
      }
    }
  }

  for (const rawEdge of edges) {
    const edge: GraphEdge = {
      ...rawEdge,
      sourceNodeId: idRemap.get(rawEdge.sourceNodeId) ?? rawEdge.sourceNodeId,
      targetNodeId: idRemap.get(rawEdge.targetNodeId) ?? rawEdge.targetNodeId,
    };
    const eKey = edgeIndexKey(edge.sourceNodeId, edge.targetNodeId, edge.type);
    const existingId = await kv.get<string>(KV.graphEdgeKey, eKey);

    let existing: GraphEdge | null = null;
    if (existingId) {
      existing = await kv.get<GraphEdge>(KV.graphEdges, existingId);
      // Same #825 orphan check as the node path above.
      if (
        existing &&
        snap.resetAt &&
        typeof existing.createdAt === "string" &&
        existing.createdAt < snap.resetAt
      ) {
        existing = null;
      }
    }

    if (existing) {
      const merged = mergeEdge(existing, obsIds);
      await kv.set(KV.graphEdges, existing.id, merged);
      // Replace cached topEdges entry too if present.
      const topIdx = snap.topEdges.findIndex((e) => e.id === existing!.id);
      if (topIdx !== -1) {
        snap.topEdges[topIdx] = stripProvenance(merged);
        snapMutated = true;
      }
    } else {
      await kv.set(KV.graphEdges, edge.id, edge);
      await kv.set(KV.graphEdgeKey, eKey, edge.id);
      await indexGraphEdge(kv, edge);
      snap.stats.totalEdges += 1;
      snap.stats.edgesByType[edge.type] =
        (snap.stats.edgesByType[edge.type] ?? 0) + 1;
      newEdgeCount += 1;
      await applyDegreeDelta(kv, snap, edge.sourceNodeId, +1);
      await applyDegreeDelta(kv, snap, edge.targetNodeId, +1);
      newEdgesForTopCheck.push(edge);
    }
  }

  // Push newly-added edges into snapshot.topEdges if both
  // endpoints are in the top-N (post-degree-delta). Done after
  // all degree updates so the topIds set is stable.
  for (const edge of newEdgesForTopCheck) {
    snapshotPushEdgeIfBothInTop(snap, edge);
  }

  if (newNodeCount > 0 || newEdgeCount > 0 || snapMutated) {
    // A snapshot stored before #1171 still carries provenance on entries this
    // batch never touched; the next write replaces it with a projected one.
    snap.topNodes = snap.topNodes.map(stripProvenance);
    snap.topEdges = snap.topEdges.map(stripProvenance);
    snap.updatedAt = capturedAt;
    snap.dirty = false;
    await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
  }

  return { newNodeCount, newEdgeCount };
}

// A Session's head batch is skipped after this many failures in a row, so a
// batch that can never extract does not cost an LLM call on every stop.
const GRAPH_BATCH_MAX_FAILURES = 3;

// An unreachable or overloaded provider says nothing about the batch, so it
// does not count toward GRAPH_BATCH_MAX_FAILURES.
function isProviderDown(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message === "circuit_breaker_open" || err.message === "fetch failed") {
    return true;
  }
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" && (status === 429 || status >= 500);
}

interface GraphExtraction {
  result: Record<string, unknown>;
  // How many leading observations were fully extracted, and the error that
  // stopped the batch after them. null when nothing was persisted.
  progress: { extracted: number; failure?: unknown } | null;
}

async function extractGraph(
  kv: StateKV,
  provider: MemoryProvider,
  rawObservations: CompressedObservation[],
  batchSize: number,
  stopAtFirstFailure: boolean,
): Promise<GraphExtraction> {
  const observations = await withProjectRelativeFiles(kv, rawObservations);
  const obsIds = observations.map((o) => o.id);

  let nodes: GraphNode[] = [];
  let edges: GraphEdge[] = [];
  const annotations = new Map<string, ObservationAnnotation>();
  try {
    const heuristic = extractGraphHeuristics(observations);
    nodes = heuristic.nodes;
    edges = heuristic.edges;
  } catch (err) {
    logger.warn("heuristic graph extraction failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const llmEnabled = isGraphExtractionEnabled() && !isNoopProvider(provider);
  let extracted = observations.length;
  let failure: unknown;
  if (llmEnabled) {
    extracted = 0;
    // Map each source observation to its session so extracted nodes
    // can be resolved back to KV.observations(sessionId) at retrieval
    // time (#656). Skip blanks defensively.
    const sessionByObsId = new Map<string, string>();
    for (const o of observations) {
      if (o.sessionId) sessionByObsId.set(o.id, o.sessionId);
    }
    // One prompt per batch bounds its size: a whole long Session in one
    // prompt ran past the LLM timeout mid-prefill.
    for (let i = 0; i < observations.length; i += batchSize) {
      const batch = observations.slice(i, i + batchSize);
      const prompt = buildGraphExtractionPrompt(
        batch.map((o) => ({
          title: o.title,
          narrative: o.narrative,
          concepts: o.concepts,
          files: o.files,
          type: o.type,
        })),
      );
      const started = Date.now();
      try {
        const response = await provider.compress(GRAPH_EXTRACTION_SYSTEM, prompt);
        const parsed = parseGraphXml(
          response,
          batch.map((o) => o.id),
          sessionByObsId,
        );
        nodes = nodes.concat(parsed.nodes);
        edges = edges.concat(parsed.edges);
        for (const [obsId, annotation] of parseObservationAnnotations(
          response,
          batch.map((o) => o.id),
        )) {
          annotations.set(obsId, annotation);
        }
        if (failure === undefined) extracted = i + batch.length;
      } catch (err) {
        failure ??= err;
        logger.error("LLM graph extraction failed", {
          error: err instanceof Error ? err.message : String(err),
          sessionId: batch[0]!.sessionId,
          sessionCount: new Set(batch.map((o) => o.sessionId)).size,
          batchSize: batch.length,
          promptChars: prompt.length,
          tookMs: Date.now() - started,
        });
        if (stopAtFirstFailure || isProviderDown(err)) break;
      }
    }
  }
  const llmError =
    failure === undefined
      ? undefined
      : failure instanceof Error
        ? failure.message
        : String(failure);

  if (nodes.length === 0 && edges.length === 0) {
    if (!llmError && annotations.size > 0) {
      await writeObservationAnnotations(kv, observations, annotations);
      await recordAudit(kv, "observe", "mem::graph-extract", obsIds, {
        nodesExtracted: 0,
        edgesExtracted: 0,
      });
    }
    return {
      result: llmError
        ? { success: false, error: llmError }
        : { success: true, nodesAdded: 0, edgesAdded: 0 },
      progress: { extracted, failure },
    };
  }

  try {
    const { newNodeCount, newEdgeCount } = await persistGraphDelta(
      kv,
      nodes,
      edges,
      obsIds,
    );

    await writeObservationAnnotations(kv, observations, annotations);

    await recordAudit(kv, "observe", "mem::graph-extract", obsIds, {
      nodesExtracted: nodes.length,
      edgesExtracted: edges.length,
    });

    logger.info("Graph extraction complete", {
      nodes: nodes.length,
      edges: edges.length,
      newNodes: newNodeCount,
      newEdges: newEdgeCount,
      llm: llmEnabled && !llmError,
    });
    return {
      result: { success: true, nodesAdded: nodes.length, edgesAdded: edges.length },
      progress: { extracted, failure },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Graph extraction failed", { error: msg });
    return { result: { success: false, error: msg }, progress: null };
  }
}

// Moves the Session's watermark past the observations that were extracted.
// A failed head batch is retried on the next stop until it has failed
// GRAPH_BATCH_MAX_FAILURES times for a reason other than the provider being
// down; then it is skipped.
async function advanceGraphWatermark(
  kv: StateKV,
  sessionId: string,
  observations: CompressedObservation[],
  batchSize: number,
  progress: { extracted: number; failure?: unknown },
): Promise<void> {
  const session = await kv.get<Session>(KV.sessions, sessionId);
  if (!session) return;

  // The next stop takes only Observations after the watermark's timestamp,
  // so the watermark must not fall between two that share one.
  let through = progress.extracted;
  const splitsTie = () =>
    through > 0 &&
    through < observations.length &&
    observations[through - 1]!.timestamp === observations[through]!.timestamp;
  while (splitsTie()) through--;

  let failures = 0;
  const skipFrom = through;
  let skipping = false;
  if (progress.failure !== undefined) {
    const counted = isProviderDown(progress.failure) ? 0 : 1;
    failures = through > 0 ? counted : (session.graphExtractFailures ?? 0) + counted;
    if (failures >= GRAPH_BATCH_MAX_FAILURES) {
      through = Math.min(observations.length, through + batchSize);
      while (splitsTie()) through++;
      failures = 0;
      skipping = true;
    }
  }
  if (skipping) {
    logger.warn("Skipping a graph batch that keeps failing", {
      sessionId,
      observations: observations.slice(skipFrom, through).map((o) => o.id),
    });
  }

  const ops: Array<{ type: "set"; path: string; value: unknown }> = [
    { type: "set", path: "graphExtractFailures", value: failures },
  ];
  if (through > 0) {
    ops.push({
      type: "set",
      path: "graphExtractedThrough",
      value: observations[through - 1]!.timestamp,
    });
  }
  await kv.update(KV.sessions, sessionId, ops);
}

export function registerGraphFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  // Sessions with an extraction running; a stop that lands meanwhile is
  // skipped and its observations go out with the next stop.
  const extracting = new Set<string>();

  // With a sessionId, observations are extracted oldest first and the
  // Session's watermark advances only past batches that succeeded.
  sdk.registerFunction("mem::graph-extract",
    async (data: { observations: CompressedObservation[]; sessionId?: string }) => {
      if (!data.observations || data.observations.length === 0) {
        return { success: false, error: "No observations provided" };
      }

      // Fork posture (graph-off): no graph write unless extraction is armed
      // AND the graph leg is not killed. persistGraphDelta() enforces the same
      // rule for every writer; returning here first just skips the heuristic
      // and LLM work whose output would be dropped anyway.
      if (graphWritesDisabled()) {
        return { success: true, nodesAdded: 0, edgesAdded: 0, skipped: "graph-writes-off" };
      }

      const { sessionId } = data;
      const batchSize = Math.max(1, getGraphBatchSize());
      if (!sessionId) {
        return (await extractGraph(kv, provider, data.observations, batchSize, false)).result;
      }
      if (extracting.has(sessionId)) {
        return { success: true, nodesAdded: 0, edgesAdded: 0, skipped: "session-extracting" };
      }
      extracting.add(sessionId);
      try {
        const observations = [...data.observations].sort((a, b) =>
          a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
        );
        const { result, progress } = await extractGraph(
          kv,
          provider,
          observations,
          batchSize,
          true,
        );
        if (progress) {
          await advanceGraphWatermark(kv, sessionId, observations, batchSize, progress);
        }
        return result;
      } finally {
        extracting.delete(sessionId);
      }
    },
  );

  // #753: every branch now applies a default cap and reports the
  // unbounded `total*` counts. Before this change, an unfiltered POST
  // /graph/query body (`{}`) on a corpus with ~10k+ nodes serialized
  // the whole graph into one response.
  sdk.registerFunction("mem::graph-query",
    async (data: {
      startNodeId?: string;
      nodeType?: string;
      maxDepth?: number;
      query?: string;
      limit?: number;
      offset?: number;
    }): Promise<GraphQueryResult> => {
      const maxDepth = Math.min(data.maxDepth || 3, 5);
      const { limit, offset } = resolvePagination(data.limit, data.offset);

      // #814 v2: the empty-body / nodeType-only path NEVER enumerates.
      // It reads the snapshot exclusively. The snapshot is updated
      // inline by graph-extract, so for newly-built corpora it's
      // always current. For legacy corpora missing a snapshot the
      // operator must run mem::graph-snapshot-rebuild (paged, any
      // size) or mem::graph-reset to wipe and
      // rebuild incrementally from new observations.
      const noWalk = !data.query && !data.startNodeId;
      if (noWalk) {
        const snap = await readSnapshot(kv);
        if (snap && snap.stats.totalNodes > 0) {
          return paginateFromSnapshot(snap, data.nodeType, limit, offset);
        }
        return {
          nodes: [],
          edges: [],
          depth: 0,
          totalNodes: 0,
          totalEdges: 0,
          truncated: false,
          limit,
          offset,
          warning:
            "No graph snapshot available. Either no graph has been " +
            "extracted yet, or you are on a legacy corpus from a pre-#814 " +
            "agentmemory build. Run POST /agentmemory/graph/snapshot-rebuild " +
            "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to " +
            "wipe and let future extracts repopulate.",
        };
      }

      // Query / startNodeId paths serve from the read side-indexes
      // when they have been built (boot backfill, snapshot-rebuild, or
      // graph-reset). Name matches come from the sharded name catalog
      // (64 bounded gets) and traversal expands via per-node adjacency
      // lists, so cost scales with matches x degree instead of corpus
      // size.
      if (await graphReadable(kv)) {
        if (data.query) {
          return queryViaIndexes(kv, data.query, limit, offset);
        }
        return traverseViaIndexes(
          kv,
          data.startNodeId!,
          data.nodeType,
          maxDepth,
          limit,
          offset,
        );
      }

      // Fail-closed (graph-read-fix local delta): the leg is off or the
      // side-indexes are unarmed. NEVER enumerate the graph scope for a
      // query / startNodeId walk — that unbounded kv.list is the pre-#814
      // "Invocation stopped" 500 and, under the leg guard, the exact read
      // B-mode must not issue. Serve the top-degree snapshot instead; when
      // armed, control returned above via the bounded side-indexes.
      const snap = await readSnapshot(kv);
      if (snap && snap.stats.totalNodes > 0) {
        return {
          ...paginateFromSnapshot(snap, data.nodeType, limit, offset),
          warning:
            "Graph leg off or side-indexes unarmed; query/startNodeId walk " +
            "unavailable. Result reflects the top-degree snapshot, not the " +
            "requested walk.",
        };
      }
      return {
        nodes: [],
        edges: [],
        depth: 0,
        totalNodes: 0,
        totalEdges: 0,
        truncated: false,
        limit,
        offset,
        warning:
          "Graph leg unavailable and no snapshot present. Enable the leg " +
          "and arm the side-indexes, or run snapshot-rebuild.",
      };
    },
  );

  // #814 v2: graph-stats reads the snapshot exclusively. The snapshot
  // is maintained inline by mem::graph-extract, so for any corpus built
  // on a post-#814 agentmemory the stats are always current without an
  // enumeration. Legacy corpora without a snapshot get an empty
  // envelope + a warning pointing at the snapshot-rebuild or graph-reset
  // endpoints — never a 500.
  sdk.registerFunction("mem::graph-stats", async () => {
    const snap = await readSnapshot(kv);
    if (snap) {
      return {
        ...snap.stats,
        fromSnapshot: true,
        updatedAt: snap.updatedAt,
        ...(snap.dirty
          ? {
              warning:
                "Snapshot is marked dirty (write was in-flight when read). " +
                "Counts are eventually consistent.",
            }
          : {}),
      };
    }
    return {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
      fromSnapshot: false,
      warning:
        "No graph snapshot available. Run POST /agentmemory/graph/snapshot-rebuild " +
        "(safe up to ~25K nodes) or POST /agentmemory/graph/reset to wipe " +
        "and let future extracts repopulate.",
    };
  });

  // #814 v2: explicit rebuild backfills the snapshot AND the name /
  // edge-key / degree indexes from existing graphNodes/graphEdges
  // scopes. This is the path operators run once after upgrading to a
  // post-#814 build to bring legacy corpora online.
  sdk.registerFunction(
    "mem::graph-snapshot-rebuild",
    async (data?: { force?: boolean }) => {
      const started = Date.now();
      // B-mode (graph-read-fix local delta): graph frozen — refuse the
      // rebuild. It enumerates the graph scope to rebuild the snapshot +
      // side-indexes, and B-mode must issue zero graph-scope reads.
      if (graphLegDisabled()) {
        return {
          success: false,
          skipped: "graph-leg-off",
          error: "Graph leg is off (B-mode); snapshot rebuild is disabled.",
        };
      }
      // #825: pre-flight refusal for legacy corpora. If no snapshot
      // exists, the corpus is either empty or legacy. Refuse both
      // unless `force: true` is passed (operator opt-in on a corpus
      // they know is small enough).
      // Strict boolean check on force — accept only literal `true`,
      // never truthy strings/numbers, so a hand-crafted JSON payload
      // can't accidentally bypass the legacy-corpus safeguard.
      const forceRebuild = data?.force === true;
      try {
        const existing = await readSnapshot(kv);
        if (!existing && !forceRebuild) {
          logger.warn("Graph snapshot rebuild refused: no prior snapshot", {
            hint: "legacy corpus or empty store",
          });
          return {
            success: false,
            legacyCorpus: true,
            error:
              "No prior snapshot found. Either (a) call " +
              "POST /agentmemory/graph/reset to drop into incremental-only " +
              "mode and rebuild from new extracts, or (b) re-send with " +
              "`force: true` to rebuild from the legacy rows in pages.",
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Graph snapshot pre-flight read failed", { error: msg });
        // Fall through; the user passed force=true or the snapshot
        // read itself failed (separate problem).
      }

      try {
      const snap = await rebuildIndexesAndSnapshot(kv);
      await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, snap);
      const tookMs = Date.now() - started;
      logger.info("Graph snapshot rebuilt", {
        totalNodes: snap.stats.totalNodes,
        totalEdges: snap.stats.totalEdges,
        topNodes: snap.topNodes.length,
        topEdges: snap.topEdges.length,
        tookMs,
      });
      return {
        success: true,
        ...snap.stats,
        topNodes: snap.topNodes.length,
        topEdges: snap.topEdges.length,
        updatedAt: snap.updatedAt,
        tookMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Graph snapshot rebuild failed", { error: msg });
      return { success: false, error: msg };
    }
  });

  // #814 v2 + #825: clean-restart escape hatch for corpora of any size.
  //
  // It never lists a scope whole: write an empty snapshot and delete the
  // adjacency / obs-node rows in pages. The hot path (mem::graph-query empty-body, mem::graph-stats)
  // reads ONLY the snapshot post-#816, so a fresh empty snapshot
  // makes the graph behave as if it were empty for every read.
  //
  // Future extracts repopulate the snapshot + side-indexes
  // incrementally (graph-extract is O(1) per node post-#816 — it does
  // not consult the legacy rows).
  //
  // Trade-off: legacy rows in KV.graphNodes / KV.graphEdges remain on
  // disk as unreferenced orphans. They consume disk but are never
  // read by any post-#816 code path. Cleanup is deferred to a future
  // chunked-vacuum job; #816's broken vacuum-via-list strategy is
  // what we are leaving behind here.
  sdk.registerFunction("mem::graph-reset", () =>
    withKeyedLock(GRAPH_WRITE_LOCK, async () => {
      const started = Date.now();
      // Stamp resetAt=now on the empty snapshot. Future
      // mem::graph-extract calls compare each name-index lookup's
      // existing node `createdAt` against this timestamp; anything
      // older counts as an orphan and is dropped from the merge path,
      // forcing extract to write a fresh row instead of reconnecting
      // to a pre-reset entry.
      const resetSnapshot: GraphSnapshot = {
        ...emptySnapshot(),
        resetAt: new Date().toISOString(),
      };
      await kv.set(KV.graphSnapshot, SNAPSHOT_KEY, resetSnapshot);
      // Pre-reset adjacency and obs-node rows are deleted in pages so a
      // reset frees their disk without listing the scopes whole. Marking
      // the indexes ready flips retrieval onto the index path, which
      // (unlike the enumeration fallback) applies the resetAt filter and
      // therefore stops surfacing pre-reset rows.
      const cleared = await clearGraphSideIndexes(kv);
      await markGraphIndexesReady(kv);
      const counts: Record<string, number> = {
        [KV.graphSnapshot]: 1,
        ...cleared,
      };
      const tookMs = Date.now() - started;
      logger.info("Graph state reset", { counts, tookMs });
      return { success: true, cleared: counts, tookMs };
    }),
  );
}
