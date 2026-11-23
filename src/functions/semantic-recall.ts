import type { SemanticMemory } from "../types.js";
import { withinDateRange, type DateRange } from "./date-range.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { STOP_WORDS } from "../state/stopwords.js";
import { capBehindNewer } from "./recency-cap.js";
import { factAliases } from "./semantic-fact-aliases.js";
import { createSessionLoader } from "./search.js";
import { semanticFactIndex, startsAWord, type IndexedFact } from "./semantic-fact-index.js";

export interface RecalledFact {
  fact: SemanticMemory;
  score: number;
}

const DAILY_RECENCY_DECAY = 0.01;

// The near-twin cap compares every pair, so it sees only the best-scoring
// candidates: tens of facts, never the whole store.
const CAP_POOL = 50;

interface Scored {
  fact: IndexedFact;
  score: number;
  matchedTexts?: string[];
}

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(EDGE_PUNCTUATION, ""))
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

// A Semantic Fact carries no project of its own: consolidation derives it
// from one project's Session Summaries, so a fact belongs to the project of
// any Session it cites. A fact whose Sessions are all gone cannot be placed
// and is left out of a project-scoped recall.
export async function recallSemanticFacts(
  kv: StateKV,
  limit: number,
  options: { query?: string; project?: string; range?: DateRange } = {},
): Promise<RecalledFact[]> {
  const hasQuery = (options.query ?? "").trim().length > 0;
  const terms = queryTerms(options.query ?? "");
  if (hasQuery && terms.length === 0) return [];
  const index = await semanticFactIndex(kv);

  let scored: Scored[] = [];
  if (terms.length > 0) {
    const matched = new Map<number, number>();
    for (const term of terms) {
      for (const at of index.matching(term)) matched.set(at, (matched.get(at) ?? 0) + 1);
    }
    for (const [at, count] of [...matched].sort(([a], [b]) => a - b)) {
      const fact = index.facts[at];
      if (!fact.aliasTexts) {
        scored.push({ fact, score: (fact.confidence * count) / terms.length });
        continue;
      }
      let bestCount = 0;
      let matchedTexts: string[] = [];
      for (const text of [fact.text, ...fact.aliasTexts]) {
        const lower = text.toLowerCase();
        const matches = terms.filter(term => startsAWord(lower, term)).length;
        if (matches > bestCount) {
          bestCount = matches;
          matchedTexts = [];
        }
        if (matches === bestCount) matchedTexts.push(text);
      }
      scored.push({ fact, score: (fact.confidence * bestCount) / terms.length, matchedTexts });
    }
  } else {
    const now = Date.now();
    for (const fact of index.facts) {
      const days = (now - fact.updatedAt) / 86_400_000;
      scored.push({ fact, score: fact.confidence / (1 + days * DAILY_RECENCY_DECAY) });
    }
  }
  if (options.range) {
    const range = options.range;
    scored = scored.filter(({ fact }) => withinDateRange(fact.createdAtRaw, range));
  }
  scored.sort((a, b) => b.score - a.score);

  const poolSize = Math.max(limit, CAP_POOL);
  const pool = options.project ? await inProject(kv, scored, options.project, poolSize) : scored.slice(0, poolSize);
  capBehindNewer(pool, (s) => s.matchedTexts ?? s.fact.text, (s) => s.fact.createdAt);
  pool.sort((a, b) => b.score - a.score);
  const rows = await Promise.all(
    pool.slice(0, limit).map(async ({ fact, score, matchedTexts }): Promise<RecalledFact | null> => {
      const current = await kv.get<SemanticMemory>(KV.semantic, fact.id);
      if (!current || current.isLatest === false || (options.range && !withinDateRange(current.createdAt, options.range))) return null;
      if (terms.length > 0) {
        const winningTexts = matchedTexts ?? [fact.text];
        if (!winningTexts.includes(current.fact) &&
            !factAliases(current.aliases).some(alias => winningTexts.includes(alias.fact))) return null;
      }
      return { fact: current, score };
    }),
  );
  return rows.filter((row): row is RecalledFact => row !== null);
}

async function inProject(
  kv: StateKV,
  ranked: Scored[],
  project: string,
  size: number,
): Promise<Scored[]> {
  const loadSession = createSessionLoader(kv);
  const kept: Scored[] = [];
  for (const candidate of ranked) {
    const sessions = await Promise.all(candidate.fact.sourceSessionIds.map(loadSession));
    if (sessions.some((s) => s?.project === project)) kept.push(candidate);
    if (kept.length === size) break;
  }
  return kept;
}
