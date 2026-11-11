import type { SemanticMemory } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";

// What recall reads of a live Semantic Fact. The full row is fetched only for
// the facts a recall returns, so the index holds a fraction of the scope.
export interface IndexedFact {
  id: string;
  text: string;
  lowerText: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  sourceSessionIds: string[];
}

export interface SemanticFactIndex {
  // In key order, which is creation order for generated ids.
  facts: IndexedFact[];
  // The positions in `facts` of the facts in which `term` (lower-case, no edge
  // punctuation) starts a word, each once.
  matching(term: string): Iterable<number>;
}

const PAGE = 500;
const WORD = /[\p{L}\p{N}]+/gu;
const LEADING_WORD = /^[\p{L}\p{N}]+/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

const indexes = new WeakMap<StateKV, { generation: number; index: Promise<SemanticFactIndex> }>();

// Every live fact, read once per store and again only after the store reports
// a write to KV.semantic, so a recall decodes no fact rows but the ones it
// returns. The read pages through the scope so the event loop turns while it
// runs. A failed read is not kept, and recalls nothing.
export async function semanticFactIndex(kv: StateKV): Promise<SemanticFactIndex> {
  const generation = await kv.writeGeneration(KV.semantic);
  let entry = indexes.get(kv);
  if (!entry || entry.generation !== generation) {
    entry = { generation, index: readIndex(kv) };
    indexes.set(kv, entry);
  }
  const current = entry;
  return current.index.catch(() => {
    if (indexes.get(kv) === current) indexes.delete(kv);
    return buildIndex([], new Map());
  });
}

export function startsAWord(text: string, term: string): boolean {
  for (let i = text.indexOf(term); i !== -1; i = text.indexOf(term, i + 1)) {
    if (i === 0 || !WORD_CHAR.test(text[i - 1])) return true;
  }
  return false;
}

async function readIndex(kv: StateKV): Promise<SemanticFactIndex> {
  const sessionIds = new Map<string, string>();
  const intern = (id: string) => sessionIds.get(id) ?? (sessionIds.set(id, id), id);
  const facts: IndexedFact[] = [];
  const postings = new Map<string, number[]>();
  for (let after: string | undefined; ; ) {
    const page = await kv.listPage<SemanticMemory>(KV.semantic, after, PAGE);
    for (const { value: fact } of page) {
      if (fact.isLatest === false) continue;
      const lowerText = fact.fact.toLowerCase();
      for (const word of new Set(lowerText.match(WORD))) {
        const list = postings.get(word);
        if (list) list.push(facts.length);
        else postings.set(word, [facts.length]);
      }
      facts.push({
        id: fact.id,
        text: fact.fact,
        lowerText,
        confidence: fact.confidence,
        createdAt: new Date(fact.createdAt).getTime(),
        updatedAt: new Date(fact.updatedAt).getTime(),
        sourceSessionIds: fact.sourceSessionIds.map(intern),
      });
    }
    if (page.length < PAGE) return buildIndex(facts, postings);
    after = page[page.length - 1].key;
  }
}

// A term starts a word exactly where some word of the text starts with the
// term's leading run of letters and digits, so the sorted vocabulary yields
// every candidate. Only a term with punctuation inside it is checked against
// the text itself.
function buildIndex(facts: IndexedFact[], postings: Map<string, number[]>): SemanticFactIndex {
  const vocabulary = [...postings.keys()].sort();
  return {
    facts,
    *matching(term) {
      const lead = term.match(LEADING_WORD)?.[0];
      if (!lead) return;
      const seen = new Set<number>();
      for (let i = lowerBound(vocabulary, lead); i < vocabulary.length && vocabulary[i].startsWith(lead); i++) {
        for (const at of postings.get(vocabulary[i])!) {
          if (seen.has(at)) continue;
          seen.add(at);
          if (lead === term || startsAWord(facts[at].lowerText, term)) yield at;
        }
      }
    },
  };
}

function lowerBound(sorted: string[], value: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
