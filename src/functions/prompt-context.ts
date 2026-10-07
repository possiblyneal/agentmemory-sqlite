import type { ISdk } from "../engine/types.js";
import type { InjectedRef, Memory } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { estimateTokens } from "../utils/tokens.js";
import { escapeXml } from "../utils/xml.js";
import { isHarnessMessage } from "../utils/harness-message.js";
import { relevantOrder } from "./prompt-rerank.js";
import { injectedInSession, refKey, withFiles } from "./injections.js";

// Chosen against the prompt-submit path of eval/data/coding-agent-life-v2
// (BM25-only): gold matches score 6.7–25, bare acknowledgements and
// unrelated prompts top out near 4.5. BM25 scores grow with corpus size, so
// the relative cutoff does most of the work on a large store.
const MIN_PROMPT_WORDS = 3;
const MIN_SCORE = 5;
const MIN_SCORE_RATIO_TO_BEST = 0.5;
const MAX_RESULTS = 3;
const MAX_NARRATIVE_CHARS = 400;
const SEARCH_LIMIT = 10;

interface SearchHit {
  score: number;
  sessionId: string;
  observation: { id: string; title?: string; narrative?: string; files?: string[] };
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

interface Candidate {
  hit: NarratedHit;
  ref: InjectedRef;
}

async function gateByRelevance(prompt: string, candidates: Candidate[]): Promise<Candidate[]> {
  if (candidates.length === 0) return candidates;
  const documents = candidates.map(({ hit }) =>
    `${hit.observation.title ?? ""} ${hit.observation.narrative.slice(0, MAX_NARRATIVE_CHARS)}`.trim(),
  );
  const order = await relevantOrder(prompt, documents);
  return order ? order.map((index) => candidates[index]) : candidates;
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
      const chosen = (await gateByRelevance(prompt, candidates)).slice(0, MAX_RESULTS);
      if (chosen.length === 0) return EMPTY;

      const lines = chosen.map(({ hit }) => escapeXml(hit.observation.narrative.slice(0, MAX_NARRATIVE_CHARS)));
      const context = `<agentmemory-relevant-context>\n${lines.join("\n")}\n</agentmemory-relevant-context>`;

      logger.info("Prompt context built", {
        sessionId: data.sessionId,
        project: data.project,
        results: chosen.length,
        contextLength: context.length,
      });

      return {
        context,
        tokens: estimateTokens(context),
        injected: chosen.map(({ ref }) => ref),
      };
    },
  );
}
