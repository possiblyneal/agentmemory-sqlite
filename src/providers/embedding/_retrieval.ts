export interface RetrievalProfile {
  queryPrefix: string;
  documentPrefix: string;
  // The cosine at or above which a BM25-matched hit counts as relevant;
  // undefined keeps smart-search's default, which is MiniLM's.
  minRelevantCosine?: number;
}

const DEFAULT_RETRIEVAL: RetrievalProfile = { queryPrefix: "", documentPrefix: "" };

// Prefixes are each model card's retrieval prompts: BGE v1.5 prefixes only
// short queries; EmbeddingGemma prefixes both sides with its search task.
// EmbeddingGemma 2 scores unrelated text at 0.54-0.68, so its floor is the
// cosine that rejects the same share of random Observation pairs (93.5%)
// as MiniLM's 0.3 (docs/benchmarks/2026-10-20-embeddinggemma-2.md).
const MODEL_RETRIEVAL: Array<[RegExp, RetrievalProfile]> = [
  [
    /bge-(small|base|large)-en-v1\.5$/i,
    { queryPrefix: "Represent this sentence for searching relevant passages: ", documentPrefix: "" },
  ],
  [
    /embeddinggemma-2/i,
    {
      queryPrefix: "task: search result | query: ",
      documentPrefix: "title: none | text: ",
      minRelevantCosine: 0.69,
    },
  ],
];

export function retrievalProfileFor(modelId: string): RetrievalProfile {
  return MODEL_RETRIEVAL.find(([pattern]) => pattern.test(modelId))?.[1] ?? DEFAULT_RETRIEVAL;
}

// A document prefix changes every stored vector, so it is part of the space.
export function withDocumentPrefix(vectorSpace: string, retrieval: RetrievalProfile): string {
  return retrieval.documentPrefix ? `${vectorSpace}:doc=${retrieval.documentPrefix}` : vectorSpace;
}
