import type { SemanticMemory } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { STOP_WORDS } from "../state/stopwords.js";
import { capBehindNewer } from "./recency-cap.js";
import { createSessionLoader } from "./search.js";

export interface RecalledFact {
  fact: SemanticMemory;
  score: number;
}

const DAILY_RECENCY_DECAY = 0.01;

// The near-twin cap compares every pair, so it sees only the best-scoring
// candidates: tens of facts, never the whole store.
const CAP_POOL = 50;

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;

function lastActiveAt(fact: SemanticMemory): number {
  return new Date(fact.updatedAt).getTime();
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(EDGE_PUNCTUATION, ""))
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function startsAWord(text: string, term: string): boolean {
  for (let i = text.indexOf(term); i !== -1; i = text.indexOf(term, i + 1)) {
    if (i === 0 || !WORD_CHAR.test(text[i - 1])) return true;
  }
  return false;
}

// A Semantic Fact carries no project of its own: consolidation derives it
// from one project's Session Summaries, so a fact belongs to the project of
// any Session it cites. A fact whose Sessions are all gone cannot be placed
// and is left out of a project-scoped recall.
export async function recallSemanticFacts(
  kv: StateKV,
  limit: number,
  options: { query?: string; project?: string } = {},
): Promise<RecalledFact[]> {
  const hasQuery = (options.query ?? "").trim().length > 0;
  const terms = queryTerms(options.query ?? "");
  if (hasQuery && terms.length === 0) return [];
  const facts = await kv.list<SemanticMemory>(KV.semantic).catch(() => [] as SemanticMemory[]);

  const scored: RecalledFact[] = [];
  for (const fact of facts) {
    if (fact.isLatest === false) continue;
    const text = fact.fact.toLowerCase();
    const matched = terms.filter((t) => startsAWord(text, t)).length;
    if (terms.length > 0 && matched === 0) continue;
    const relevance = terms.length > 0 ? matched / terms.length : 1;
    const days = terms.length > 0 ? 0 : (Date.now() - lastActiveAt(fact)) / 86_400_000;
    scored.push({ fact, score: (fact.confidence * relevance) / (1 + days * DAILY_RECENCY_DECAY) });
  }
  scored.sort((a, b) => b.score - a.score);

  const poolSize = Math.max(limit, CAP_POOL);
  const pool = options.project ? await inProject(kv, scored, options.project, poolSize) : scored.slice(0, poolSize);
  capBehindNewer(pool, (s) => s.fact.fact, (s) => new Date(s.fact.createdAt).getTime());
  pool.sort((a, b) => b.score - a.score);
  return pool.slice(0, limit);
}

async function inProject(
  kv: StateKV,
  ranked: RecalledFact[],
  project: string,
  size: number,
): Promise<RecalledFact[]> {
  const loadSession = createSessionLoader(kv);
  const kept: RecalledFact[] = [];
  for (const candidate of ranked) {
    const sessions = await Promise.all(candidate.fact.sourceSessionIds.map(loadSession));
    if (sessions.some((s) => s?.project === project)) kept.push(candidate);
    if (kept.length === size) break;
  }
  return kept;
}
