import type { ISdk } from "../engine/types.js";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import type {
  Insight,
  GraphNode,
  GraphEdge,
  SemanticMemory,
  Lesson,
  Crystal,
  MemoryProvider,
  Session,
} from "../types.js";
import { recordAudit } from "./audit.js";
import {
  REFLECT_SYSTEM,
  buildReflectPrompt,
  formatNarrativeLine,
  formatScoredLine,
  EXISTING_INSIGHT_LIMIT,
} from "../prompts/reflect.js";
import { graphLegDisabled, readBoundedGraphSnapshot } from "../state/graph-indexes.js";
import { loadProjectTime } from "../state/project-time.js";
import { CONSOLIDATION_PROMPT_CHARS } from "../prompts/budget.js";
import { logger } from "../logger.js";
import { MAX_SOURCE_LIST_IDS } from "./graph-provenance.js";
import { getInsightMaxIdleWeeks } from "../config.js";
import { insightClusterKey, compareShown } from "./insight-merge.js";

const MIN_CLUSTER_ITEMS = 3;
// Nodes one reflect pass reads from the graph indexes.
const REFLECT_GRAPH_NODE_LIMIT = 5000;
// What a cluster's reflect last read, under KV.config, keyed by the cluster.
const reflectInputsKey = (clusterKey: string): string =>
  fingerprintId("reflect:inputs", clusterKey);

interface ConceptCluster {
  concepts: string[];
  facts: Array<{ fact: string; confidence: number }>;
  lessons: Array<{ content: string; confidence: number }>;
  crystalNarratives: string[];
  factIds: string[];
  lessonIds: string[];
  crystalIds: string[];
  existingInsights: Insight[];
}

// Lessons and crystals are the more durable record, so they fill the budget
// before facts. Lessons and facts go strongest first, crystals newest first.
// An item too large for what is left is skipped and smaller ones keep filling.
function fitClusterToBudget(
  concepts: string[],
  lessons: Lesson[],
  crystals: Crystal[],
  facts: SemanticMemory[],
  existingInsights: Insight[],
): { lessons: Lesson[]; crystals: Crystal[]; facts: SemanticMemory[] } {
  // Rendering every section with an empty item reserves the intro, concept
  // header and section headings before any item is counted.
  const header = buildReflectPrompt({
    concepts,
    facts: [{ fact: "", confidence: 0 }],
    lessons: [{ content: "", confidence: 0 }],
    crystalNarratives: [""],
    existingInsights,
  });
  let remaining = CONSOLIDATION_PROMPT_CHARS - header.length;
  const take = <T>(items: T[], line: (item: T) => string): T[] =>
    items.filter((item) => {
      const chars = line(item).length + 1;
      if (chars > remaining) return false;
      remaining -= chars;
      return true;
    });
  return {
    lessons: take(
      [...lessons].sort((a, b) => b.confidence - a.confidence),
      (l) => formatScoredLine(l.confidence, l.content),
    ),
    crystals: take(
      [...crystals].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
      (c) => formatNarrativeLine(c.narrative),
    ),
    facts: take(
      [...facts].sort((a, b) => b.confidence - a.confidence),
      (f) => formatScoredLine(f.confidence, f.fact),
    ),
  };
}

function reinforceInsight(insight: Insight): void {
  const now = new Date().toISOString();
  insight.reinforcements++;
  insight.confidence = Math.min(
    1.0,
    insight.confidence + 0.1 * (1 - insight.confidence),
  );
  insight.lastReinforcedAt = now;
  insight.updatedAt = now;
}

function buildGraphClusters(
  nodes: GraphNode[],
  edges: GraphEdge[],
  maxClusters: number,
): string[][] {
  const conceptNodes = nodes.filter(
    (n) => n.type === "concept" && !n.stale,
  );
  if (conceptNodes.length === 0) return [];

  const edgeMap = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.stale) continue;
    if (!edgeMap.has(edge.sourceNodeId))
      edgeMap.set(edge.sourceNodeId, new Set());
    if (!edgeMap.has(edge.targetNodeId))
      edgeMap.set(edge.targetNodeId, new Set());
    edgeMap.get(edge.sourceNodeId)!.add(edge.targetNodeId);
    edgeMap.get(edge.targetNodeId)!.add(edge.sourceNodeId);
  }

  const degree = new Map<string, number>();
  for (const node of conceptNodes) {
    degree.set(node.id, edgeMap.get(node.id)?.size || 0);
  }

  const sorted = [...conceptNodes].sort(
    (a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0),
  );

  const visited = new Set<string>();
  const clusters: string[][] = [];
  const conceptById = new Map(conceptNodes.map((n) => [n.id, n]));

  for (const seed of sorted) {
    if (clusters.length >= maxClusters) break;
    if (visited.has(seed.id)) continue;

    const cluster: string[] = [];
    const queue = [seed.id];
    const seen = new Set<string>();
    let depth = 0;

    while (queue.length > 0 && depth <= 2) {
      const levelCount = queue.length;
      for (let i = 0; i < levelCount; i++) {
        const current = queue.shift()!;
        if (seen.has(current) || visited.has(current)) continue;
        seen.add(current);

        const node = conceptById.get(current);
        if (node) {
          cluster.push(node.name);
          visited.add(current);
        }

        const neighbors = edgeMap.get(current) || new Set();
        for (const neighbor of neighbors) {
          if (!seen.has(neighbor)) queue.push(neighbor);
        }
      }
      depth++;
    }

    if (cluster.length >= 2) clusters.push(cluster);
  }

  return clusters;
}

function buildJaccardClusters(
  semanticMemories: SemanticMemory[],
  lessons: Lesson[],
  maxClusters: number,
): string[][] {
  const allConcepts = new Map<string, Set<string>>();

  for (const sem of semanticMemories) {
    const terms = sem.fact.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
    for (const term of terms) {
      if (!allConcepts.has(term)) allConcepts.set(term, new Set());
      allConcepts.get(term)!.add(sem.id);
    }
  }
  for (const lesson of lessons) {
    for (const tag of lesson.tags) {
      const key = tag.toLowerCase();
      if (!allConcepts.has(key)) allConcepts.set(key, new Set());
      allConcepts.get(key)!.add(lesson.id);
    }
  }

  const conceptList = [...allConcepts.keys()].filter(
    (k) => (allConcepts.get(k)?.size || 0) >= 2,
  );

  const visited = new Set<string>();
  const clusters: string[][] = [];

  for (const concept of conceptList) {
    if (visited.has(concept) || clusters.length >= maxClusters) break;

    const cluster = [concept];
    visited.add(concept);

    const docsA = allConcepts.get(concept) || new Set();
    for (const other of conceptList) {
      if (visited.has(other)) continue;
      const docsB = allConcepts.get(other) || new Set();
      let intersection = 0;
      for (const d of docsA) {
        if (docsB.has(d)) intersection++;
      }
      const union = docsA.size + docsB.size - intersection;
      const similarity = union > 0 ? intersection / union : 0;
      if (similarity > 0.3) {
        cluster.push(other);
        visited.add(other);
      }
    }

    if (cluster.length >= 2) clusters.push(cluster);
  }

  return clusters;
}

// Insights are never compared with earlier ones, so two with one title (and
// project) are the same claim restated; the newer holds and takes the better slot.
function newestFirstWithinTitle(scored: Array<{ insight: Insight; score: number }>): void {
  const groups = new Map<string, Array<{ insight: Insight; score: number }>>();
  for (const entry of scored) {
    const key = `${entry.insight.project ?? ""}\u0000${entry.insight.title.trim().toLowerCase()}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const claimedAt = (i: Insight) => Date.parse(i.lastReinforcedAt ?? i.createdAt);
  const slots = new Map<{ insight: Insight; score: number }, number>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const positions = group.map((e) => scored.indexOf(e)).sort((a, b) => a - b);
    const newestFirst = [...group].sort((a, b) => claimedAt(b.insight) - claimedAt(a.insight));
    const bestScores = group.map((e) => e.score).sort((a, b) => b - a);
    newestFirst.forEach((e, n) => slots.set(e, positions[n]));
    newestFirst.forEach((e, n) => { e.score = bestScores[n]; });
  }
  if (slots.size === 0) return;
  const ordered = [...scored];
  for (const [entry, pos] of slots) ordered[pos] = entry;
  scored.splice(0, scored.length, ...ordered);
}

export function registerReflectFunctions(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::reflect", 
    async (data: { maxClusters?: number; project?: string }) => {
      const maxClusters = Math.min(data?.maxClusters ?? 10, 20);
      const maxInsightsPerCluster = 5;
      const maxTotal = 50;

      const project = data?.project;
      const projectSessionIds = project
        ? new Set(
            (await kv.list<Session>(KV.sessions))
              .filter((s) => s.project === project)
              .map((s) => s.id),
          )
        : undefined;
      const inProject = (n: GraphNode): boolean =>
        !projectSessionIds ||
        (n.sessionId !== undefined && projectSessionIds.has(n.sessionId));

      const noGraph = { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
      const [graph, semanticMemories, lessons, crystals] =
        await Promise.all([
          // B-mode: graph frozen — skip graph-scope reads, cluster over
          // semantic/lessons/crystals only.
          graphLegDisabled()
            ? noGraph
            : readBoundedGraphSnapshot(kv, REFLECT_GRAPH_NODE_LIMIT, inProject).catch(
                () => noGraph,
              ),
          kv.list<SemanticMemory>(KV.semantic).then((all) => all.filter((m) => m.isLatest !== false)).catch(() => []),
          kv.list<Lesson>(KV.lessons).catch(() => []),
          kv.list<Crystal>(KV.crystals).catch(() => []),
        ]);

      let activeLessons = lessons;
      let scopedSemantic = semanticMemories;
      let scopedCrystals = crystals;
      const scopedNodes = graph.nodes;
      let scopedEdges = graph.edges;
      // One project's clusters must never borrow another's facts, crystals or
      // concepts: an insight is stamped with the project it was built for (#1344).
      if (project && projectSessionIds) {
        activeLessons = activeLessons.filter((l) => l.project === project);
        scopedSemantic = semanticMemories.filter((m) =>
          m.sourceSessionIds.some((id) => projectSessionIds.has(id)),
        );
        scopedCrystals = crystals.filter((c) => c.project === project);
        const nodeIds = new Set(scopedNodes.map((n) => n.id));
        scopedEdges = graph.edges.filter(
          (e) => nodeIds.has(e.sourceNodeId) && nodeIds.has(e.targetNodeId),
        );
      }

      let conceptClusters = buildGraphClusters(
        scopedNodes,
        scopedEdges,
        maxClusters,
      );

      const clusterStrategy = conceptClusters.length === 0 ? "jaccard" : "graph";
      if (clusterStrategy === "jaccard") {
        conceptClusters = buildJaccardClusters(
          scopedSemantic,
          activeLessons,
          maxClusters,
        );
      }

      const clusterInsights = new Map<string, Insight[]>();
      for (const insight of await kv.list<Insight>(KV.insights).catch(() => [] as Insight[])) {
        if (insight.deleted) continue;
        const key = insightClusterKey(insight.project, insight.sourceConceptCluster);
        const group = clusterInsights.get(key);
        if (group) group.push(insight);
        else clusterInsights.set(key, [insight]);
      }

      let newInsights = 0;
      let reinforced = 0;
      let clustersSkipped = 0;
      let clustersUnchanged = 0;
      let totalInsights = 0;

      for (const conceptNames of conceptClusters) {
        if (totalInsights >= maxTotal) break;

        const conceptSet = new Set(conceptNames.map((c) => c.toLowerCase()));

        const clusterFacts = scopedSemantic.filter((s) => {
          const factTerms = s.fact.toLowerCase().split(/\s+/);
          return factTerms.some((t) => conceptSet.has(t));
        });

        const clusterLessons = activeLessons.filter((l) =>
          l.tags.some((t) => conceptSet.has(t.toLowerCase())) ||
          conceptNames.some((c) =>
            l.content.toLowerCase().includes(c.toLowerCase()),
          ),
        );

        const clusterCrystals = scopedCrystals.filter((c) =>
          (c.lessons || []).some((l) =>
            conceptNames.some((cn) =>
              l.toLowerCase().includes(cn.toLowerCase()),
            ),
          ),
        );

        const totalItems =
          clusterFacts.length + clusterLessons.length + clusterCrystals.length;
        if (totalItems < MIN_CLUSTER_ITEMS) {
          clustersSkipped++;
          continue;
        }

        const clusterKey = insightClusterKey(data?.project, conceptNames);
        const siblings = clusterInsights.get(clusterKey) ?? [];
        // Strongest first, so the prompt carries the Insights most worth reinforcing.
        const shownInsights = [...siblings]
          .sort(compareShown)
          .slice(0, EXISTING_INSIGHT_LIMIT);

        const fitted = fitClusterToBudget(
          conceptNames,
          clusterLessons,
          clusterCrystals,
          clusterFacts,
          shownInsights,
        );
        const keptItems =
          fitted.facts.length + fitted.lessons.length + fitted.crystals.length;
        if (keptItems < totalItems) {
          logger.info("Reflect cluster trimmed to its prompt budget", {
            project: data?.project,
            concepts: conceptNames,
            keptItems,
            droppedItems: totalItems - keptItems,
          });
        }
        if (keptItems < MIN_CLUSTER_ITEMS) {
          clustersSkipped++;
          continue;
        }

        const inputsKey = reflectInputsKey(clusterKey);
        const inputsHash = fingerprintId(
          "inputs",
          [
            ...fitted.facts.map((f) => `f:${f.id}:${f.fact}`),
            ...fitted.lessons.map((l) => `l:${l.id}:${l.content}`),
            ...fitted.crystals.map((c) => `c:${c.id}:${c.narrative}`),
          ]
            .sort()
            .join("\n"),
        );
        const lastInputs = await kv.get<{ hash: string }>(KV.config, inputsKey).catch(() => null);
        if (lastInputs?.hash === inputsHash) {
          clustersUnchanged++;
          continue;
        }

        const cluster: ConceptCluster = {
          concepts: conceptNames,
          facts: fitted.facts.map((f) => ({
            fact: f.fact,
            confidence: f.confidence,
          })),
          lessons: fitted.lessons.map((l) => ({
            content: l.content,
            confidence: l.confidence,
          })),
          crystalNarratives: fitted.crystals.map((c) => c.narrative),
          factIds: fitted.facts.map((f) => f.id),
          lessonIds: fitted.lessons.map((l) => l.id),
          crystalIds: fitted.crystals.map((c) => c.id),
          existingInsights: shownInsights,
        };

        try {
          const prompt = buildReflectPrompt(cluster);
          const response = await provider.summarize(REFLECT_SYSTEM, prompt);

          const insightRegex =
            /<insight\s+confidence="([^"]+)"\s+title="([^"]+)"([^>]*)>([\s\S]*?)<\/insight>/g;
          let match;
          let clusterCount = 0;

          while (
            (match = insightRegex.exec(response)) !== null &&
            clusterCount < maxInsightsPerCluster &&
            totalInsights < maxTotal
          ) {
            const parsedConf = parseFloat(match[1]);
            const confidence = Number.isNaN(parsedConf)
              ? 0.5
              : Math.max(0, Math.min(1, parsedConf));
            const title = match[2].trim();
            const reinforcesId = /reinforces="([^"]*)"/.exec(match[3])?.[1]?.trim();
            const content = match[4].trim();

            if (!content) continue;

            const fp = fingerprintId("ins", content.trim().toLowerCase());
            const existing = await kv.get<Insight>(KV.insights, fp);
            // The id must name an Insight of this cluster and project; any
            // other id is the model inventing one, so the Insight is new.
            const restated =
              existing && !existing.deleted
                ? existing
                : siblings.find((i) => i.id === reinforcesId);

            if (restated) {
              reinforceInsight(restated);
              await kv.set(KV.insights, restated.id, restated);
              reinforced++;
            } else {
              const now = new Date().toISOString();
              const insight: Insight = {
                id: fp,
                title,
                content,
                confidence,
                reinforcements: 0,
                sourceConceptCluster: conceptNames,
                sourceMemoryIds: cluster.factIds.slice(0, MAX_SOURCE_LIST_IDS),
                sourceLessonIds: cluster.lessonIds,
                sourceCrystalIds: cluster.crystalIds,
                project: data?.project,
                tags: conceptNames,
                createdAt: now,
                updatedAt: now,
                decayRate: 0.05,
              };
              await kv.set(KV.insights, insight.id, insight);
              clusterInsights.set(clusterKey, [...(clusterInsights.get(clusterKey) ?? []), insight]);
              newInsights++;
            }

            clusterCount++;
            totalInsights++;
          }
          await kv.set(KV.config, inputsKey, { hash: inputsHash, at: new Date().toISOString() });
        } catch {
          continue;
        }
      }

      try {
        await recordAudit(kv, "reflect", "mem::reflect", [], {
          newInsights,
          reinforced,
          clustersProcessed: conceptClusters.length - clustersSkipped - clustersUnchanged,
          clustersSkipped,
          clustersUnchanged,
          clusterStrategy,
        });
      } catch {}

      return {
        success: true,
        newInsights,
        reinforced,
        clustersProcessed: conceptClusters.length - clustersSkipped - clustersUnchanged,
        clustersSkipped,
        clustersUnchanged,
        clusterStrategy,
      };
    },
  );

  sdk.registerFunction("mem::insight-list", 
    async (data: {
      project?: string;
      minConfidence?: number;
      limit?: number;
    }) => {
      const limit = data?.limit ?? 50;
      const minConfidence = data?.minConfidence ?? 0;
      let items = await kv.list<Insight>(KV.insights);

      items = items.filter(
        (i) => !i.deleted && i.confidence >= minConfidence,
      );

      if (data?.project) {
        items = items.filter((i) => i.project === data.project);
      }

      items.sort((a, b) => b.confidence - a.confidence);

      return { success: true, insights: items.slice(0, limit), total: items.length };
    },
  );

  sdk.registerFunction("mem::insight-search", 
    async (data: {
      query: string;
      project?: string;
      minConfidence?: number;
      limit?: number;
    }) => {
      if (!data?.query?.trim()) {
        return { success: false, error: "query is required" };
      }

      const query = data.query.toLowerCase();
      const minConfidence = data.minConfidence ?? 0.1;
      const limit = data.limit ?? 10;

      let items = await kv.list<Insight>(KV.insights);
      items = items.filter(
        (i) => !i.deleted && i.confidence >= minConfidence,
      );

      if (data.project) {
        items = items.filter((i) => i.project === data.project);
      }

      const terms = query.split(/\s+/).filter((t) => t.length > 1);
      const scored = items
        .map((i) => {
          const text =
            `${i.title} ${i.content} ${i.tags.join(" ")}`.toLowerCase();
          const matchCount = terms.filter((t) => text.includes(t)).length;
          if (matchCount === 0) return null;

          const relevance = matchCount / terms.length;
          const daysSince = i.lastReinforcedAt
            ? (Date.now() - new Date(i.lastReinforcedAt).getTime()) /
              (1000 * 60 * 60 * 24)
            : (Date.now() - new Date(i.createdAt).getTime()) /
              (1000 * 60 * 60 * 24);
          const recencyBoost = 1 / (1 + daysSince * 0.01);
          const score = i.confidence * relevance * recencyBoost;

          return { insight: i, score };
        })
        .filter(Boolean) as Array<{ insight: Insight; score: number }>;

      scored.sort((a, b) => b.score - a.score);
      newestFirstWithinTitle(scored);

      try {
        await recordAudit(kv, "insight_search", "mem::insight-search", [], {
          query: data.query,
          resultCount: scored.length,
        });
      } catch {}

      return {
        success: true,
        insights: scored.slice(0, limit).map((s) => ({
          ...s.insight,
          score: Math.round(s.score * 1000) / 1000,
        })),
      };
    },
  );

  sdk.registerFunction("mem::insight-decay-sweep", 
    async () => {
      const [items, activeWeeksSince] = await Promise.all([
        kv.list<Insight>(KV.insights),
        loadProjectTime(kv),
      ]);
      const timestamp = new Date().toISOString();
      const maxIdleWeeks = getInsightMaxIdleWeeks();
      const dirty: Array<{ insight: Insight; readUpdatedAt: string }> = [];
      const expired: Array<{ key: string; updatedAt: string }> = [];
      const activeWeeksApplied: Record<string, number> = {};

      for (const insight of items) {
        if (insight.deleted) {
          expired.push({ key: insight.id, updatedAt: insight.updatedAt });
          continue;
        }

        const lastUsedAt = insight.lastReinforcedAt || insight.createdAt;
        if (activeWeeksSince(insight.project, lastUsedAt, timestamp) > maxIdleWeeks) {
          expired.push({ key: insight.id, updatedAt: insight.updatedAt });
          continue;
        }

        const baseline =
          insight.lastDecayedAt ||
          insight.lastReinforcedAt ||
          insight.createdAt;
        const activeWeeks = activeWeeksSince(insight.project, baseline, timestamp);

        if (activeWeeks < 1) continue;

        const decay = insight.decayRate * activeWeeks;
        const newConfidence = Math.max(0.05, insight.confidence - decay);

        if (newConfidence !== insight.confidence) {
          activeWeeksApplied[insight.id] = activeWeeks;
          const confidence = Math.round(newConfidence * 1000) / 1000;
          if (confidence <= 0.1 && insight.reinforcements === 0) {
            expired.push({ key: insight.id, updatedAt: insight.updatedAt });
            continue;
          }
          const readUpdatedAt = insight.updatedAt;
          insight.confidence = confidence;
          insight.lastDecayedAt = timestamp;
          insight.updatedAt = timestamp;
          dirty.push({ insight, readUpdatedAt });
        }
      }

      // Awaited batches, not a fan-out: N un-awaited sets run back to back on
      // the event loop under inproc (see StateKV.setMany).
      const decayedIds = await kv.setManyIfUnchanged(
        KV.insights,
        dirty.map(({ insight, readUpdatedAt }) => ({ key: insight.id, value: insight, updatedAt: readUpdatedAt })),
      );
      const deletedIds = await kv.deleteManyIfUnchanged(KV.insights, expired);
      await recordAudit(kv, "reflect", "mem::insight-decay-sweep", [...decayedIds, ...deletedIds], {
        event: "insight.decay",
        decayed: decayedIds.length,
        deleted: deletedIds.length,
        deletedIds,
        activeWeeks: activeWeeksApplied,
        total: items.length,
        timestamp,
      });

      return { success: true, decayed: decayedIds.length, deleted: deletedIds.length, total: items.length };
    },
  );
}
