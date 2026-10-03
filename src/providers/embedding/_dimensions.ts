/**
 * Shared embedding-dimension logic for OpenAI-compatible providers.
 *
 * OpenAI and OpenRouter expose the same underlying embedding models, so they
 * share one dimension table and one resolver. OpenRouter namespaces model ids
 * (e.g. "openai/text-embedding-3-small"); the lookup strips a leading
 * "provider/" prefix so both bare and namespaced keys resolve to the same
 * dimensions.
 *
 * The dimension guard (index.ts) throws on mismatch, so a wrong value here
 * breaks every embed call — keep entries accurate. Callers pass the relevant
 * env-var name (OPENAI_EMBEDDING_DIMENSIONS / OPENROUTER_EMBEDDING_DIMENSIONS)
 * so error messages point at the knob the operator actually set.
 */
const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  "nomic-embed-text-v1.5": 768,
  "qwen3-embedding-0.6b": 1024,
  "qwen3-embedding-4b": 2560,
  "qwen3-embedding-8b": 4096,
};

function lookupModelDimensions(model: string): number | undefined {
  const id = model.toLowerCase();
  if (id in MODEL_DIMENSIONS) return MODEL_DIMENSIONS[id];
  const slash = id.indexOf("/");
  if (slash === -1) return undefined;
  return MODEL_DIMENSIONS[id.slice(slash + 1)];
}

export function resolveDimensions(
  model: string,
  override: string | undefined,
  envName: string,
): number {
  if (override !== undefined && override.trim().length > 0) {
    const parsed = parseInt(override, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `${envName} must be a positive integer, got: ${override}`,
      );
    }
    return parsed;
  }
  const known = lookupModelDimensions(model);
  if (known !== undefined) return known;
  // The table holds only OpenAI's models and a few Matryoshka families, so most
  // self-hosted or brokered models are unknown here. Guessing 1536 produces a
  // provider that claims one width while the model returns another: every
  // vector is written at the real width, cross-dimension cosine returns 0,
  // and the mismatch only surfaces as a refusal to start on some later boot -
  // by which time the store is full of vectors the guard cannot reconcile.
  // Refuse now, naming the one knob that answers it.
  throw new Error(
    `Embedding dimensions for model "${model}" are unknown. Set ${envName} to ` +
      `the width the model actually returns (known models: ` +
      `${Object.keys(MODEL_DIMENSIONS).join(", ")}).`,
  );
}

// The `dimensions` field to send, if any. Only a known model with a width
// other than its native one is a request to shorten; for an unknown model the
// env var declares the width it returns, and servers that cannot shorten
// (vLLM on a non-Matryoshka model) reject the field outright.
export function requestedDimensions(model: string, dimensions: number): number | undefined {
  const native = lookupModelDimensions(model);
  return native !== undefined && native !== dimensions ? dimensions : undefined;
}

export { MODEL_DIMENSIONS };
