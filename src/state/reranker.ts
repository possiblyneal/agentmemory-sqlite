import type { HybridSearchResult } from "../types.js";
import { configureTransformers } from "../providers/transformers-env.js";
import { logger } from "../logger.js";

const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

type CrossEncoder = { tokenizer: any; model: any };

let encoder: CrossEncoder | null = null;
let encoderLoading: Promise<CrossEncoder | null> | null = null;
let encoderUnavailable = false;
let scoringFailureLogged = false;

// [CLS] query [SEP] passage [SEP]
const PAIR_SPECIAL_TOKENS = 3;

async function loadEncoder(): Promise<CrossEncoder | null> {
  if (encoderUnavailable) return null;
  if (encoder) return encoder;
  if (encoderLoading) return encoderLoading;

  encoderLoading = (async () => {
    try {
      const transformers = configureTransformers(
        await import("@huggingface/transformers"),
      );
      const [tokenizer, model] = await Promise.all([
        transformers.AutoTokenizer.from_pretrained(RERANK_MODEL),
        transformers.AutoModelForSequenceClassification.from_pretrained(
          RERANK_MODEL,
          { dtype: "q8" },
        ),
      ]);
      encoder = { tokenizer, model };
      return encoder;
    } catch {
      encoder = null;
      encoderUnavailable = true;
      return null;
    } finally {
      encoderLoading = null;
    }
  })();
  return encoderLoading;
}

// The cross-encoder emits one relevance logit per query/passage pair; a
// text-classification pipeline softmaxes that single logit to 1.0 for every
// pair, so score the pair directly and squash the logit to (0, 1).
async function scorePairs(
  { tokenizer, model }: CrossEncoder,
  query: string,
  passages: string[],
): Promise<number[]> {
  const queryTokens = tokenizer.encode(query, { add_special_tokens: false }).length;
  const budget = Math.max(0, tokenizer.model_max_length - queryTokens - PAIR_SPECIAL_TOKENS);
  const inputs = tokenizer(new Array(passages.length).fill(query), {
    text_pair: passages.map((p) => fitPassage(tokenizer, budget, p)),
    padding: true,
    truncation: true,
  });
  const { logits } = await model(inputs);
  return Array.from(logits.data as Float32Array, (l) => 1 / (1 + Math.exp(-l)));
}

// The tokenizer's own truncation cuts the joined pair from the end, dropping
// the closing [SEP] the cross-encoder was trained on; trim only the passage.
function fitPassage(tokenizer: any, budget: number, passage: string): string {
  const ids: number[] = tokenizer.encode(passage, { add_special_tokens: false });
  return ids.length <= budget ? passage : tokenizer.decode(ids.slice(0, budget));
}

export async function rerank(
  query: string,
  results: HybridSearchResult[],
  topK = 20,
): Promise<HybridSearchResult[]> {
  if (results.length <= 1) return results;

  const crossEncoder = await loadEncoder();
  if (!crossEncoder) return results;

  const candidates = results.slice(0, Math.min(results.length, topK));
  const passages = candidates.map(
    (r) => `${r.observation.title || ""} ${r.observation.narrative || ""}`,
  );

  let scores: Array<{ result: HybridSearchResult; rerankScore: number }>;
  try {
    const relevance = await scorePairs(crossEncoder, query, passages);
    scores = candidates.map((result, i) => ({ result, rerankScore: relevance[i] }));
  } catch (err) {
    if (!scoringFailureLogged) {
      scoringFailureLogged = true;
      logger.warn("reranker scoring failed; returning results unreranked", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return results;
  }

  scores.sort((a, b) => b.rerankScore - a.rerankScore);

  return scores.map((s, i) => ({
    ...s.result,
    combinedScore: s.rerankScore,
    rerankPosition: i + 1,
  }));
}

export function isRerankerAvailable(): boolean {
  return encoder !== null;
}
