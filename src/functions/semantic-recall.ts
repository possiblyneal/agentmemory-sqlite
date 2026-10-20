import type { SemanticMemory } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { capBehindNewer } from "./recency-cap.js";
import { createSessionLoader } from "./search.js";

export interface RecalledFact {
  fact: SemanticMemory;
  score: number;
}

const DAILY_RECENCY_DECAY = 0.01;

function lastActiveAt(fact: SemanticMemory): number {
  return new Date(fact.updatedAt).getTime();
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
    if (fact.isLatest === false) continue;
    const text = fact.fact.toLowerCase();
    const matched = terms.filter((t) => text.includes(t)).length;
    if (terms.length > 0 && matched === 0) continue;
    const relevance = terms.length > 0 ? matched / terms.length : 1;
    const days = terms.length > 0 ? 0 : (Date.now() - lastActiveAt(fact)) / 86_400_000;
    scored.push({ fact, score: (fact.confidence * relevance) / (1 + days * DAILY_RECENCY_DECAY) });
  }

  const { project } = options;
  let candidates = scored;
  if (project) {
    const loadSession = createSessionLoader(kv);
    const inProject = await Promise.all(
      scored.map(async ({ fact }) => {
        const sessions = await Promise.all(fact.sourceSessionIds.map(loadSession));
        return sessions.some((s) => s?.project === project);
      }),
    );
    candidates = scored.filter((_, i) => inProject[i]);
  }
  capBehindNewer(candidates, (s) => s.fact.fact, (s) => lastActiveAt(s.fact));
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}
