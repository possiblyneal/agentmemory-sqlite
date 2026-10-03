import type { ISdk } from "../engine/types.js";
import type { InjectedRef, InjectionRecord } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import { estimateTokens } from "../utils/tokens.js";
import { withFiles } from "./injections.js";

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
  observation: { id: string; narrative?: string; files?: string[] };
}

export interface PromptContextResult {
  context: string;
  tokens: number;
  injected: InjectedRef[];
}

const EMPTY: PromptContextResult = { context: "", tokens: 0, injected: [] };

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wordCount(prompt: string): number {
  return prompt.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

async function alreadyInjected(kv: StateKV, sessionId: string): Promise<Set<string>> {
  const records = await kv.list<InjectionRecord>(KV.injections);
  return new Set(
    records
      .filter((r) => r.sessionId === sessionId)
      .flatMap((r) => r.injected.map((ref) => `${ref.kind}:${ref.id}`)),
  );
}

export function registerPromptContextFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::prompt-context",
    async (data: { sessionId: string; prompt: string; project?: string }): Promise<PromptContextResult> => {
      const prompt = data.prompt.trim();
      if (wordCount(prompt) < MIN_PROMPT_WORDS) return EMPTY;

      const [search, seen] = await Promise.all([
        sdk
          .trigger<{ query: string; limit: number; project?: string }, { results: SearchHit[] }>({
            function_id: "mem::search",
            payload: {
              query: prompt,
              limit: SEARCH_LIMIT,
              ...(data.project && { project: data.project }),
            },
          })
          .catch((): { results: SearchHit[] } => ({ results: [] })),
        alreadyInjected(kv, data.sessionId),
      ]);

      const best = search.results[0]?.score ?? 0;
      const floor = Math.max(MIN_SCORE, best * MIN_SCORE_RATIO_TO_BEST);
      const chosen = search.results
        .filter((r) => r.score >= floor && r.observation.narrative)
        .filter((r) => !seen.has(`observation:${r.observation.id}`))
        .slice(0, MAX_RESULTS);
      if (chosen.length === 0) return EMPTY;

      const lines = chosen.map((r) => escapeXml(r.observation.narrative!.slice(0, MAX_NARRATIVE_CHARS)));
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
        injected: chosen.map((r) => withFiles({ kind: "observation", id: r.observation.id }, r.observation.files)),
      };
    },
  );
}
