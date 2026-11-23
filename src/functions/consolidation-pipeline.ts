import type { ISdk } from "../engine/types.js";
import type {
  SemanticMemory,
  ProceduralMemory,
  SessionSummary,
  MemoryProvider,
} from "../types.js";
import { KV, generateId, jaccardSimilarity } from "../state/schema.js";
import { RESTATEMENT_OVERLAP } from "./recency-cap.js";
import { factAliases } from "./semantic-fact-aliases.js";
import type { StateKV } from "../state/kv.js";
import {
  SEMANTIC_MERGE_SYSTEM,
  buildSemanticMergePrompt,
} from "../prompts/consolidation.js";
import { recordAudit } from "./audit.js";
import {
  getConsolidatedMemoryForgetDays,
  getConsolidationDecayDays,
  isConsolidationEnabled,
} from "../config.js";
import { logger } from "../logger.js";
import { capSourceIds, MAX_SOURCE_LIST_IDS } from "./graph-provenance.js";
import { createSessionLoader } from "./search.js";

export const DECAY_FLOOR = 0.1;
const DAY_MS = 1000 * 60 * 60 * 24;

export function decayedStrength(base: number, periods: number): number {
  return Math.max(DECAY_FLOOR, base * Math.pow(0.9, periods));
}

const MAX_FACT_VERIFICATIONS = 20;

function normalizeKeyPart(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function parseFactAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(/(\w+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

function factKey(
  attrs: Record<string, string>,
): { subject: string; relation: string; object: string } | null {
  const subject = normalizeKeyPart(attrs.subject);
  const relation = normalizeKeyPart(attrs.relation);
  const object = normalizeKeyPart(attrs.object);
  return subject && relation && object ? { subject, relation, object } : null;
}

// Returns the rows whose strength changed, so the caller writes only those. A
// row inside its decay window or already at the 0.1 floor is left alone: the
// old "rewrite every row" tier was 45k fsyncs per run (day-0 soak finding).
// Periods count from the later of the last access and the last decay, and
// lastDecayedAt advances by the whole periods applied, so each idle period
// lowers strength once however often the tier runs.
function applyDecay<
  T extends {
    strength: number;
    lastAccessedAt?: string;
    lastDecayedAt?: string;
    updatedAt: string;
  },
>(items: T[], decayDays: number): T[] {
  if (decayDays <= 0 || !Number.isFinite(decayDays)) return [];
  const changed: T[] = [];
  const now = Date.now();
  const periodMs = decayDays * DAY_MS;
  for (const item of items) {
    const reference = Math.max(
      new Date(item.lastAccessedAt || item.updatedAt).getTime(),
      item.lastDecayedAt ? new Date(item.lastDecayedAt).getTime() : -Infinity,
    );
    const periods = Math.floor((now - reference) / periodMs);
    if (periods < 1) continue;
    const next = decayedStrength(item.strength, periods);
    if (next !== item.strength) {
      item.strength = next;
      item.lastDecayedAt = new Date(reference + periods * periodMs).toISOString();
      changed.push(item);
    }
  }
  return changed;
}

const UNSCOPED_CURSOR_KEY = "consolidation:unscopedCursor";

interface UnscopedCursor {
  lastRunAt: string;
  retryProjects: string[];
}

function forgettable<
  T extends {
    id: string;
    strength: number;
    accessCount?: number;
    lastAccessedAt?: string;
    updatedAt: string;
  },
>(items: T[], forgetDays: number): Array<{ key: string; updatedAt: string }> {
  if (forgetDays <= 0) return [];
  const cutoff = Date.now() - forgetDays * 24 * 60 * 60 * 1000;
  return items
    .filter(
      (item) =>
        item.strength <= DECAY_FLOOR &&
        (item.accessCount ?? 0) === 0 &&
        new Date(item.lastAccessedAt || item.updatedAt).getTime() < cutoff,
    )
    .map((item) => ({ key: item.id, updatedAt: item.updatedAt }));
}

export function registerConsolidationPipelineFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  verifyFact?: (left: string, right: string) => Promise<boolean>,
): void {
  // The 5 min session-end cooldown and the 120 min timer are schedules, not a
  // lock: a run that outlived them was joined by a second one over the same
  // rows (day-0 soak finding). One run at a time; a caller that finds one in
  // flight is told so and skipped, not queued.
  let inflight: Promise<unknown> | null = null;
  sdk.registerFunction("mem::consolidate-pipeline",
    async (data?: { tier?: string; force?: boolean; project?: string }) => {
      if (!data?.force && !isConsolidationEnabled()) {
        return { success: false, skipped: true, reason: "Consolidation disabled: set CONSOLIDATION_ENABLED=true or configure an LLM provider (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY / MINIMAX_API_KEY / OPENAI_BASE_URL / AGENTMEMORY_PROVIDER=agent-sdk)" };
      }
      if (inflight) {
        return { success: false, skipped: true, reason: "Consolidation pipeline already running" };
      }
      inflight = run(data);
      try {
        return await inflight;
      } finally {
        inflight = null;
      }
    },
  );

  // Summaries and insights from one project must never feed another's
  // consolidation (#1344): an unscoped run consolidates each project that has
  // new summaries since the last unscoped run, one project at a time. A project
  // whose merge or reflect failed is retried on the next unscoped run. The
  // cursor and retry set live in KV: held in memory, every restart re-ran
  // reflect for each project summarized in the past 24h. A read error aborts
  // the run rather than falling back, since the fallback's write would wipe
  // the stored retry set.
  async function loadUnscopedCursor(): Promise<UnscopedCursor> {
    const stored = await kv.get<Partial<UnscopedCursor>>(KV.config, UNSCOPED_CURSOR_KEY);
    return {
      lastRunAt: typeof stored?.lastRunAt === "string"
        ? stored.lastRunAt
        : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      retryProjects: Array.isArray(stored?.retryProjects) ? stored.retryProjects : [],
    };
  }

  async function consolidateSemantic(project: string, summaries: SessionSummary[]) {
    if (summaries.length < 5) {
      return { skipped: true, reason: "fewer than 5 summaries" };
    }
    const existingSemantic = await kv.list<SemanticMemory>(KV.semantic);
    const loadSession = createSessionLoader(kv);
    // An unkeyed fact has no project of its own; keying it for this project is
    // safe only when every Session it cites is this project's.
    const citesOnlyProject = async (fact: SemanticMemory, project: string) =>
      (await Promise.all(fact.sourceSessionIds.map(loadSession))).every(
        (session) => session?.project === project,
      );
    const recentSummaries = summaries
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() -
          new Date(a.createdAt).getTime(),
      )
      .slice(0, 20);

    const prompt = buildSemanticMergePrompt(
      recentSummaries.map((s) => ({
        title: s.title,
        narrative: s.narrative,
        concepts: s.concepts,
      })),
    );

    try {
      const response = await provider.summarize(
        SEMANTIC_MERGE_SYSTEM,
        prompt,
      );

      const factRegex = /<fact\s+([^>]*)>([^<]+)<\/fact>/g;
      let match;
      let newFacts = 0;
      let superseded = 0;
      let verificationCalls = 0;
      const now = new Date().toISOString();
      const sessionIds = recentSummaries.map((s) => s.sessionId);

      while ((match = factRegex.exec(response)) !== null) {
        const attrs = parseFactAttributes(match[1]);
        const parsedConf = parseFloat(attrs.confidence ?? "");
        const confidence = Number.isNaN(parsedConf) ? 0.5 : parsedConf;
        const fact = match[2].trim();
        const key = factKey(attrs);

        const live = existingSemantic.filter((s) => s.isLatest !== false);
        const matchesKey = (member: Pick<SemanticMemory, "subject" | "relation">) =>
          key !== null && member.subject === key.subject && member.relation === key.relation;
        const members = (row: SemanticMemory) => [row, ...factAliases(row.aliases)];
        const sameKey = key ? live.filter(row => row.project === project && members(row).some(matchesKey)) : [];
        const sameValue = (row: SemanticMemory) =>
          members(row).some(member => matchesKey(member) && member.object === key?.object);
        const lowerFact = fact.toLowerCase();
        let textMatch = live.find(row =>
          (row.project === undefined || row.project === project) &&
          (sameKey.length === 0 || (sameKey.includes(row) && sameValue(row))) &&
          (!key || !row.subject || sameValue(row)) &&
          members(row).some(member => member.fact.toLowerCase() === lowerFact),
        );
        if (textMatch && key && !textMatch.subject && !(await citesOnlyProject(textMatch, project))) {
          textMatch = undefined;
        }
        const reinforce = (row: SemanticMemory): SemanticMemory => ({
          ...row,
          accessCount: row.accessCount + 1,
          lastAccessedAt: now,
          updatedAt: now,
          confidence: Math.max(row.confidence, confidence),
          sourceSessionIds: capSourceIds([...row.sourceSessionIds, ...sessionIds], MAX_SOURCE_LIST_IDS),
          ...(key && !row.subject ? { project, ...key } : {}),
        });
        const existing = textMatch ?? sameKey.find(sameValue);
        let target: SemanticMemory | undefined;
        if (!existing && key && sameKey.length === 0 && verifyFact && verificationCalls < MAX_FACT_VERIFICATIONS) {
          const object = key.object.normalize("NFC").trim();
          let candidate: SemanticMemory | undefined;
          for (const row of live) {
            if (row.project !== project || !row.subject || !row.relation ||
                typeof row.object !== "string" || row.object.normalize("NFC").trim() !== object ||
                jaccardSimilarity(row.fact, fact) < RESTATEMENT_OVERLAP) continue;
            if (candidate) {
              candidate = undefined;
              break;
            }
            candidate = row;
          }
          if (candidate) {
            verificationCalls++;
            if (await verifyFact(candidate.fact, fact).catch(() => false) === true) {
              const at = existingSemantic.indexOf(candidate);
              const value = { ...reinforce(candidate), aliases: [...factAliases(candidate.aliases), { ...key, fact }] };
              if (await kv.replaceIfEqual(KV.semantic, candidate.id, candidate, value)) target = value;
              const latest = target ?? await kv.get<SemanticMemory>(KV.semantic, candidate.id);
              if (latest) existingSemantic[at] = latest;
              else existingSemantic.splice(at, 1);
            }
          }
        }
        if (existing) {
          const value = reinforce(existing);
          await kv.set(KV.semantic, value.id, value);
          Object.assign(existing, value);
          target = existing;
        } else if (!target) {
          target = {
            id: generateId("sem"),
            fact,
            confidence,
            sourceSessionIds: sessionIds,
            sourceMemoryIds: [],
            accessCount: 1,
            lastAccessedAt: now,
            strength: confidence,
            createdAt: now,
            updatedAt: now,
            ...(key ? { project, ...key } : {}),
          };
          await kv.set(KV.semantic, target.id, target);
          existingSemantic.push(target);
          newFacts++;
        }
        const closed = key
          ? sameKey.filter(row => row !== target && members(row).some(member =>
              matchesKey(member) && member.object !== key.object))
          : [];
        for (const old of closed) {
          const primaryMatches = old.subject === key!.subject && old.relation === key!.relation;
          const aliases = factAliases(old.aliases).filter((member) => member.subject !== key!.subject || member.relation !== key!.relation);
          if (primaryMatches && aliases.length > 0) {
            const [{ subject, relation, object, fact }, ...remaining] = aliases;
            Object.assign(old, { subject, relation, object, fact, aliases: remaining });
          } else if (!primaryMatches) {
            old.aliases = aliases;
          } else {
            old.isLatest = false;
            old.supersededBy = target.id;
          }
          old.updatedAt = now;
          await kv.set(KV.semantic, old.id, old);
          superseded++;
        }
        if (closed.length > 0) {
          await recordAudit(kv, "evolve", "mem::consolidate-pipeline", [
            ...closed.map((s) => s.id),
            target.id,
          ], {
            event: "semantic.supersede",
            project,
            subject: key!.subject,
            relation: key!.relation,
            supersededIds: closed.map((s) => s.id),
            supersededBy: target.id,
          });
        }
      }
      return superseded > 0
        ? { newFacts, superseded, totalSummaries: summaries.length }
        : { newFacts, totalSummaries: summaries.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Semantic consolidation failed", { error: msg });
      return { error: msg };
    }
  }

  async function reflect(project: string) {
    try {
      return await sdk.trigger<unknown, { clustersFailed?: number; error?: string }>({ function_id: "mem::reflect", payload: {
        maxClusters: 10,
        project,
      } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Reflect tier failed", { error: msg, project });
      return { error: msg };
    }
  }

  async function run(data?: { tier?: string; project?: string }) {
    const tier = data?.tier || "all";
    const decayDays = getConsolidationDecayDays();
    const results: Record<string, unknown> = {};

    const runsSemantic = tier === "all" || tier === "semantic";
    const runsReflect = tier === "all" || tier === "reflect";
    if (runsSemantic || runsReflect) {
      const startedAt = new Date().toISOString();
      const summaries = await kv.list<SessionSummary>(KV.summaries);
      const cursor = data?.project ? null : await loadUnscopedCursor();
      const retryProjects = new Set(cursor?.retryProjects);
      const projects = cursor
        ? [...new Set([
            ...retryProjects,
            ...summaries
              .filter((s) => s.project && s.createdAt > cursor.lastRunAt)
              .map((s) => s.project),
          ])]
        : [data!.project!];
      const semanticByProject: Record<string, Awaited<ReturnType<typeof consolidateSemantic>>> = {};
      const reflectByProject: Record<string, Awaited<ReturnType<typeof reflect>>> = {};
      for (const project of projects) {
        if (runsSemantic) {
          semanticByProject[project] = await consolidateSemantic(
            project,
            summaries.filter((s) => s.project === project),
          );
        }
        if (runsReflect) reflectByProject[project] = await reflect(project);
        const reflectResult = reflectByProject[project];
        const failed = "error" in (semanticByProject[project] ?? {}) ||
          reflectResult?.error !== undefined || (reflectResult?.clustersFailed ?? 0) > 0;
        if (data?.project) continue;
        if (failed) retryProjects.add(project);
        else retryProjects.delete(project);
      }
      if (runsSemantic) results.semantic = semanticByProject;
      if (runsReflect) results.reflect = reflectByProject;
      if (!data?.project) {
        await kv
          .set<UnscopedCursor>(KV.config, UNSCOPED_CURSOR_KEY, {
            lastRunAt: startedAt,
            retryProjects: [...retryProjects],
          })
          .catch((err) =>
            logger.warn("Consolidation cursor not saved", {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
      }
    }

    if (tier === "all" || tier === "procedural") {
      results.procedural = {
        skipped: true,
        reason: "procedural extraction retired",
        newProcedures: 0,
        patternsAnalyzed: 0,
      };
    }

    if (tier === "all" || tier === "decay") {
      const semantic = await kv.list<SemanticMemory>(KV.semantic);
      const semanticChanged = applyDecay(semantic, decayDays);
      await kv.setMany(KV.semantic, semanticChanged.map((s) => ({ key: s.id, value: s })));

      const procedural = await kv.list<ProceduralMemory>(KV.procedural);
      const proceduralChanged = applyDecay(procedural, decayDays);
      await kv.setMany(KV.procedural, proceduralChanged.map((p) => ({ key: p.id, value: p })));

      const forgetDays = getConsolidatedMemoryForgetDays();
      const [forgottenSemantic, forgottenProcedural] = await Promise.all([
        kv.deleteManyIfUnchanged(KV.semantic, forgettable(semantic, forgetDays)),
        kv.deleteManyIfUnchanged(KV.procedural, forgettable(procedural, forgetDays)),
      ]);
      if (forgottenSemantic.length + forgottenProcedural.length > 0) {
        await recordAudit(
          kv,
          "forget",
          "mem::consolidate-pipeline",
          [...forgottenSemantic, ...forgottenProcedural],
          {
            event: "consolidated.forget",
            forgetDays,
            semanticIds: forgottenSemantic,
            proceduralIds: forgottenProcedural,
          },
        );
      }

      results.decay = {
        semantic: semantic.length,
        procedural: procedural.length,
        semanticWritten: semanticChanged.length,
        proceduralWritten: proceduralChanged.length,
        semanticForgotten: forgottenSemantic.length,
        proceduralForgotten: forgottenProcedural.length,
      };
    }

    if (process.env["OBSIDIAN_AUTO_EXPORT"] === "true") {
      try {
        await sdk.trigger({ function_id: "mem::obsidian-export", payload: {} });
        results.obsidianExport = { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Obsidian auto-export failed", { error: msg });
        results.obsidianExport = { success: false, error: msg };
      }
    }

    await recordAudit(kv, "consolidate", "mem::consolidate-pipeline", [], {
      tier,
      results,
    });

    logger.info("Consolidation pipeline complete", { tier, results });
    return { success: true, results };
  }
}
