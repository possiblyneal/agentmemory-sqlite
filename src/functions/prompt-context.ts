import type { ISdk } from "../engine/types.js";
import type { InjectedRef, Memory, SessionSummary } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { estimateTokens } from "../utils/tokens.js";
import { escapeXml } from "../utils/xml.js";
import { isHarnessMessage } from "../utils/harness-message.js";
import { gateByRelevance } from "./prompt-rerank.js";
import { injectedInSession, refKey, withFiles } from "./injections.js";
import { summaryCovers } from "./summarize.js";

// Chosen against the prompt-submit path of eval/data/coding-agent-life-v2
// (BM25-only): gold matches score 6.7–25, bare acknowledgements and
// unrelated prompts top out near 4.5. BM25 scores grow with corpus size, so
// the relative cutoff does most of the work on a large store.
const MIN_PROMPT_WORDS = 3;
const MIN_SCORE = 5;
const MIN_SCORE_RATIO_TO_BEST = 0.5;
const MAX_RESULTS = 3;
const MAX_NARRATIVE_CHARS = 400;
const MAX_DECISION_CHARS = 300;
const MAX_DECISIONS = 10;
const SEARCH_LIMIT = 30;
const AMENDMENT_MIN_RATIO = 0.35;
const AMENDMENT_MIN_LEAD = 1.25;

interface SearchHit {
  score: number;
  sessionId: string;
  observation: { id: string; timestamp?: string; title?: string; narrative?: string; files?: string[] };
}

type NarratedHit = SearchHit & { observation: { narrative: string } };

export interface PromptContextResult {
  context: string;
  tokens: number;
  injected: InjectedRef[];
}

const EMPTY: PromptContextResult = { context: "", tokens: 0, injected: [] };

function wordCount(prompt: string): number {
  return prompt.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

// mem::search returns Memories in the Observation shape, under the
// Memory's own id, so only the Memory store can tell the two apart.
async function refFor(kv: StateKV, hit: NarratedHit): Promise<InjectedRef> {
  const memory = await kv.get<Memory>(KV.memories, hit.observation.id).catch(() => null);
  return withFiles({ kind: memory ? "memory" : "observation", id: hit.observation.id }, hit.observation.files);
}

type Candidate = { hit: NarratedHit; ref: InjectedRef };
type Resolved = Candidate & { summary: SessionSummary | null };

// An Observation a Session Summary covers is a fragment of a conversation
// whose conclusions the Summary already holds, so the Session's decisions
// stand in for it.
async function withCoveringSummaries(kv: StateKV, ranked: Candidate[]): Promise<Resolved[]> {
  const summaries = await Promise.all(
    ranked.map(({ hit, ref }) =>
      ref.kind === "observation" ? kv.get<SessionSummary>(KV.summaries, hit.sessionId).catch(() => null) : null,
    ),
  );
  return ranked.map((c, i) => {
    const summary = summaries[i];
    const { timestamp } = c.hit.observation;
    const covers = !!summary?.keyDecisions?.length && !!timestamp && summaryCovers(summary, timestamp);
    return { ...c, summary: covers ? summary : null };
  });
}

// A covered Session renders once however many of its Observations hit, so
// the result budget counts Sessions, not hits: a second hit from the same
// Session would spend a slot another Session could use.
function distinctUnits(ranked: Resolved[]): Resolved[] {
  const sessions = new Set<string>();
  const units: Resolved[] = [];
  for (const r of ranked) {
    if (r.summary && sessions.has(r.hit.sessionId)) continue;
    if (r.summary) sessions.add(r.hit.sessionId);
    units.push(r);
  }
  return units;
}

// A Session that amends another's rules restates them, so a search on those
// rules finds it. Measured on sdebench's amended tasks against 140 decoys: the
// amendment is the closest other Session, scores at least 0.35 of the
// Session's own best hit and leads the runner-up by 1.25x; a decoy rarely
// does all three while also being the later Session.
async function laterAmendment(
  sdk: ISdk,
  kv: StateKV,
  unit: Resolved & { summary: SessionSummary },
  skip: (sessionId: string) => boolean,
  project?: string,
): Promise<Resolved | null> {
  const { results } = await sdk.trigger<{ query: string; limit: number; project?: string }, { results: SearchHit[] }>({
    function_id: "mem::search",
    payload: {
      query: [unit.summary.title, ...unit.summary.keyDecisions].join(" "),
      limit: SEARCH_LIMIT,
      ...(project && { project }),
    },
  });
  const bestPerSession = new Map<string, SearchHit>();
  for (const r of results) {
    if ((bestPerSession.get(r.sessionId)?.score ?? -Infinity) < r.score) bestPerSession.set(r.sessionId, r);
  }
  const own = bestPerSession.get(unit.hit.sessionId)?.score ?? 0;
  bestPerSession.delete(unit.hit.sessionId);
  const [top, runnerUp] = [...bestPerSession.values()].sort((a, b) => b.score - a.score);
  if (!top?.observation.narrative || !top.observation.timestamp || skip(top.sessionId)) return null;
  if (top.observation.timestamp <= unit.hit.observation.timestamp!) return null;
  if (top.score < own * AMENDMENT_MIN_RATIO || (runnerUp && top.score < runnerUp.score * AMENDMENT_MIN_LEAD)) return null;
  const hit = top as NarratedHit;
  const [resolved] = await withCoveringSummaries(kv, [{ hit, ref: await refFor(kv, hit) }]);
  return resolved.summary ? resolved : null;
}

async function withLaterAmendments(
  sdk: ISdk,
  kv: StateKV,
  chosen: Resolved[],
  skip: (sessionId: string) => boolean,
  project?: string,
): Promise<Resolved[]> {
  const given = new Set(chosen.map((c) => c.hit.sessionId));
  const amendments = await Promise.all(
    chosen.map((c) =>
      c.summary
        ? laterAmendment(sdk, kv, { ...c, summary: c.summary }, (id) => given.has(id) || skip(id), project)
        : null,
    ),
  );
  const added = new Set<string>();
  const fresh = amendments.filter((a): a is Resolved => {
    if (!a || added.has(a.hit.sessionId)) return false;
    added.add(a.hit.sessionId);
    return true;
  });
  return [...chosen, ...fresh];
}

// Decisions lead, newest Session first, so a later Session that amends a
// rule is read before the rule it replaces.
function renderWithSessionDecisions(chosen: Resolved[]) {
  const fragments: string[] = [];
  const fragmentRefs: InjectedRef[] = [];
  const sessions: Array<{ sessionId: string; summary: SessionSummary; at: string }> = [];
  for (const { hit, ref, summary } of chosen) {
    if (!summary) {
      fragments.push(escapeXml(hit.observation.narrative.slice(0, MAX_NARRATIVE_CHARS)));
      fragmentRefs.push(ref);
      continue;
    }
    sessions.push({ sessionId: hit.sessionId, summary, at: summary.coveredThrough ?? summary.createdAt });
  }
  const newestFirst = sessions.sort((a, b) => b.at.localeCompare(a.at));
  const lines = newestFirst.length
    ? ["Requirements the user settled in past Sessions of this project. They still hold: where the task touches what a rule governs, apply it with its exact values, even where the current code does not follow it yet. Newest Session first; where two of these conflict, the newer one holds."]
    : [];
  for (const { summary, at } of newestFirst) {
    lines.push(
      `Session "${escapeXml(summary.title)}" (${at.slice(0, 10)}):`,
      ...summary.keyDecisions.slice(0, MAX_DECISIONS).map((d) => `- ${escapeXml(d.slice(0, MAX_DECISION_CHARS))}`),
    );
  }
  return {
    lines: [...lines, ...fragments],
    injected: [
      ...newestFirst.map(({ sessionId, summary }) => withFiles({ kind: "summary", id: sessionId }, summary.filesModified)),
      ...fragmentRefs,
    ],
  };
}

export function registerPromptContextFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::prompt-context",
    async (data: { sessionId: string; prompt: string; project?: string }): Promise<PromptContextResult> => {
      const prompt = data.prompt.trim();
      if (wordCount(prompt) < MIN_PROMPT_WORDS || isHarnessMessage(prompt)) return EMPTY;

      const [search, seen] = await Promise.all([
        sdk
          .trigger<{ query: string; limit: number; project?: string }, { results: SearchHit[] }>({
            function_id: "mem::search",
            payload: {
              query: prompt,
              limit: SEARCH_LIMIT,
              ...(data.project && { project: data.project }),
            },
          }),
        injectedInSession(kv, data.sessionId),
      ]);

      // This Session's own Observations, the prompt just observed among
      // them, are already in the Agent's context.
      const earlier = search.results.filter((r) => r.sessionId !== data.sessionId);
      const best = earlier[0]?.score ?? 0;
      const floor = Math.max(MIN_SCORE, best * MIN_SCORE_RATIO_TO_BEST);
      const strong = earlier.filter(
        (r): r is NarratedHit =>
          r.score >= floor && !!r.observation.narrative && !seen.has(refKey({ kind: "summary", id: r.sessionId })),
      );
      const refs = await Promise.all(strong.map((r) => refFor(kv, r)));
      const candidates = strong
        .map((hit, i) => ({ hit, ref: refs[i] }))
        .filter(({ ref }) => !seen.has(refKey(ref)));
      const gated = await gateByRelevance(prompt, candidates, ({ hit }) => hit.observation);
      const chosen = distinctUnits(await withCoveringSummaries(kv, gated)).slice(0, MAX_RESULTS);
      if (chosen.length === 0) return EMPTY;

      const withAmendments = await withLaterAmendments(
        sdk,
        kv,
        chosen,
        (id) => id === data.sessionId || seen.has(refKey({ kind: "summary", id })),
        data.project,
      );
      const { lines, injected } = renderWithSessionDecisions(withAmendments);
      const context = `<agentmemory-relevant-context>\n${lines.join("\n")}\n</agentmemory-relevant-context>`;

      logger.info("Prompt context built", {
        sessionId: data.sessionId,
        project: data.project,
        results: injected.length,
        contextLength: context.length,
      });

      return {
        context,
        tokens: estimateTokens(context),
        injected,
      };
    },
  );
}
