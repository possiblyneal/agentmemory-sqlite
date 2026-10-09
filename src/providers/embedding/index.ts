import type { EmbeddingProvider } from "../../types.js";
import { detectEmbeddingProvider, getEnvVar } from "../../config.js";
import { GeminiEmbeddingProvider } from "./gemini.js";
import { OpenAIEmbeddingProvider } from "./openai.js";
import { VoyageEmbeddingProvider } from "./voyage.js";
import { CohereEmbeddingProvider } from "./cohere.js";
import { OpenRouterEmbeddingProvider } from "./openrouter.js";
import { LocalEmbeddingProvider } from "./local.js";
import { ClipEmbeddingProvider } from "./clip.js";

export {
  GeminiEmbeddingProvider,
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
  CohereEmbeddingProvider,
  OpenRouterEmbeddingProvider,
  LocalEmbeddingProvider,
  ClipEmbeddingProvider,
};

let imageEmbeddingProvider: EmbeddingProvider | null = null;

export function createImageEmbeddingProvider(): EmbeddingProvider | null {
  if (process.env["AGENTMEMORY_IMAGE_EMBEDDINGS"] !== "true") return null;
  if (imageEmbeddingProvider) return imageEmbeddingProvider;
  imageEmbeddingProvider = withEmbeddingGuards(new ClipEmbeddingProvider());
  return imageEmbeddingProvider;
}

export function createEmbeddingProvider(): EmbeddingProvider | null {
  const detected = detectEmbeddingProvider();
  if (!detected) return null;

  switch (detected) {
    case "gemini":
      return withEmbeddingGuards(new GeminiEmbeddingProvider(getEnvVar("GEMINI_API_KEY")!));
    case "openai":
      return withEmbeddingGuards(new OpenAIEmbeddingProvider(getEnvVar("OPENAI_API_KEY")!));
    case "voyage":
      return withEmbeddingGuards(new VoyageEmbeddingProvider(getEnvVar("VOYAGE_API_KEY")!));
    case "cohere":
      return withEmbeddingGuards(new CohereEmbeddingProvider(getEnvVar("COHERE_API_KEY")!));
    case "openrouter":
      return withEmbeddingGuards(new OpenRouterEmbeddingProvider(getEnvVar("OPENROUTER_API_KEY")!));
    case "local":
      return withEmbeddingGuards(new LocalEmbeddingProvider());
    default:
      return null;
  }
}

// Wrong-dimension vectors corrupt the index silently: vector-index.ts
// returns 0 from cosineSimilarity on length mismatch instead of throwing,
// so a bad vector is stored, never matches anything, and the memory
// becomes invisible without an error. Catch it at the boundary.
// A lone surrogate, left by any cut that counts UTF-16 units, makes the
// provider reject the whole request, so input is made well-formed here too.
export function withEmbeddingGuards(provider: EmbeddingProvider): EmbeddingProvider {
  const expected = provider.dimensions;
  const check = (v: Float32Array, where: string): Float32Array => {
    if (v.length !== expected) {
      throw new Error(
        `Embedding dimension mismatch in ${provider.name}.${where}: expected ${expected}, got ${v.length}`,
      );
    }
    return v;
  };
  // Preserve the provider's prototype chain so `instanceof` checks
  // against concrete classes (e.g. GeminiEmbeddingProvider) keep working.
  const wrapped = Object.create(provider) as EmbeddingProvider;
  wrapped.embed = async (t) => check(await provider.embed(t.toWellFormed()), "embed");
  wrapped.embedBatch = async (ts) => {
    const out = await provider.embedBatch(ts.map((t) => t.toWellFormed()));
    out.forEach((v, i) => check(v, `embedBatch[${i}]`));
    return out;
  };
  if (provider.embedQuery) {
    wrapped.embedQuery = async (t) => check(await provider.embedQuery!(t.toWellFormed()), "embedQuery");
  }
  if (provider.embedImage) {
    wrapped.embedImage = async (s: string) =>
      check(await provider.embedImage!(s), "embedImage");
  }
  return wrapped;
}

export function vectorSpaceOf(provider: EmbeddingProvider): string {
  return provider.vectorSpace ?? `${provider.name}:${provider.dimensions}`;
}

export function embedQuery(provider: EmbeddingProvider, text: string): Promise<Float32Array> {
  return provider.embedQuery ? provider.embedQuery(text) : provider.embed(text);
}
