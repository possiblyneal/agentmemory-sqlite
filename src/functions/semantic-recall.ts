import type { SemanticMemory } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { createSessionLoader } from "./search.js";

export interface RecalledFact {
  fact: SemanticMemory;
  score: number;
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
  const terms = (options.query ?? "").toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const facts = await kv.list<SemanticMemory>(KV.semantic).catch(() => [] as SemanticMemory[]);

  const scored: RecalledFact[] = [];
  for (const fact of facts) {
    const text = fact.fact.toLowerCase();
    const matched = terms.filter((t) => text.includes(t)).length;
    if (terms.length > 0 && matched === 0) continue;
    const relevance = terms.length > 0 ? matched / terms.length : 1;
    scored.push({ fact, score: fact.confidence * relevance });
  }
  scored.sort((a, b) => b.score - a.score);

  const { project } = options;
  if (!project) return scored.slice(0, limit);

  const loadSession = createSessionLoader(kv);
  const recalled: RecalledFact[] = [];
  for (const candidate of scored) {
    if (recalled.length >= limit) break;
    const sessions = await Promise.all(candidate.fact.sourceSessionIds.map(loadSession));
    if (sessions.some((s) => s?.project === project)) recalled.push(candidate);
  }
  return recalled;
}
