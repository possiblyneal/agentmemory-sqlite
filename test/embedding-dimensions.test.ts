import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveDimensions } from "../src/providers/embedding/_dimensions.js";
import { OpenRouterEmbeddingProvider } from "../src/providers/embedding/openrouter.js";
import { OpenAIEmbeddingProvider } from "../src/providers/embedding/openai.js";

describe("resolveDimensions", () => {
  const ENV = "OPENROUTER_EMBEDDING_DIMENSIONS";

  it("resolves namespaced OpenRouter model ids to their real dimensions", () => {
    expect(resolveDimensions("openai/text-embedding-3-large", undefined, ENV)).toBe(3072);
    expect(resolveDimensions("openai/text-embedding-3-small", undefined, ENV)).toBe(1536);
    expect(resolveDimensions("openai/text-embedding-ada-002", undefined, ENV)).toBe(1536);
  });

  it("resolves bare model ids to their real dimensions", () => {
    expect(resolveDimensions("text-embedding-3-large", undefined, ENV)).toBe(3072);
    expect(resolveDimensions("text-embedding-3-small", undefined, ENV)).toBe(1536);
    expect(resolveDimensions("text-embedding-ada-002", undefined, ENV)).toBe(1536);
  });

  it("lets a valid override win over the model-derived dimensions", () => {
    expect(resolveDimensions("openai/text-embedding-3-large", "1024", ENV)).toBe(1024);
    expect(resolveDimensions("text-embedding-3-small", "768", ENV)).toBe(768);
  });

  it("throws with the given env name on invalid override values", () => {
    for (const bad of ["abc", "0", "-5"]) {
      expect(() => resolveDimensions("text-embedding-3-large", bad, ENV)).toThrow(
        new RegExp(`${ENV} must be a positive integer, got: ${bad}`),
      );
    }
  });

  it("uses the supplied env name in the error message", () => {
    expect(() => resolveDimensions("text-embedding-3-large", "abc", "OPENAI_EMBEDDING_DIMENSIONS")).toThrow(
      /OPENAI_EMBEDDING_DIMENSIONS must be a positive integer, got: abc/,
    );
  });

  it("refuses an unknown model rather than guessing a width", () => {
    // A guess is unverifiable until the store is already full of vectors at
    // the real width, so the failure has to land at construction.
    expect(() => resolveDimensions("mystery-self-hosted-model", undefined, ENV)).toThrow(
      /dimensions for model "mystery-self-hosted-model" are unknown/,
    );
    // The message names the caller's own knob, not a fixed variable.
    expect(() => resolveDimensions("someprovider/unknown-model", undefined, ENV)).toThrow(
      new RegExp(`Set ${ENV} to the width`),
    );
  });

  it("still takes an explicit width for an unknown model", () => {
    expect(resolveDimensions("wemm-embedding", "4096", ENV)).toBe(4096);
  });
});

describe("OpenRouterEmbeddingProvider dimension regression", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["OPENROUTER_EMBEDDING_MODEL"];
    delete process.env["OPENROUTER_EMBEDDING_DIMENSIONS"];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("reports 3072 for openai/text-embedding-3-large with no override (guard would throw on the old hardcoded 1536)", () => {
    process.env["OPENROUTER_EMBEDDING_MODEL"] = "openai/text-embedding-3-large";
    const provider = new OpenRouterEmbeddingProvider("test-key");
    expect(provider.dimensions).toBe(3072);
  });

  it("defaults to 1536 for openai/text-embedding-3-small", () => {
    const provider = new OpenRouterEmbeddingProvider("test-key");
    expect(provider.dimensions).toBe(1536);
  });

  it("lets OPENROUTER_EMBEDDING_DIMENSIONS override the model-derived dimensions", () => {
    process.env["OPENROUTER_EMBEDDING_MODEL"] = "openai/text-embedding-3-large";
    process.env["OPENROUTER_EMBEDDING_DIMENSIONS"] = "1024";
    const provider = new OpenRouterEmbeddingProvider("test-key");
    expect(provider.dimensions).toBe(1024);
  });
});

describe("OpenAIEmbeddingProvider defaults unchanged", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["OPENAI_EMBEDDING_MODEL"];
    delete process.env["OPENAI_EMBEDDING_DIMENSIONS"];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults to 1536 for text-embedding-3-small", () => {
    const provider = new OpenAIEmbeddingProvider("test-key");
    expect(provider.dimensions).toBe(1536);
  });

  it("reports 3072 for text-embedding-3-large", () => {
    process.env["OPENAI_EMBEDDING_MODEL"] = "text-embedding-3-large";
    const provider = new OpenAIEmbeddingProvider("test-key");
    expect(provider.dimensions).toBe(3072);
  });
});

describe("requested dimensions reach the request body (PR #1369)", () => {
  const originalEnv = { ...process.env };

  function stubFetch(width: number) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ embedding: new Array(width).fill(0) }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  function sentBody(spy: ReturnType<typeof stubFetch>): Record<string, unknown> {
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string);
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const k of [
      "OPENAI_EMBEDDING_MODEL", "OPENAI_EMBEDDING_DIMENSIONS", "OPENAI_EMBEDDING_BASE_URL", "OPENAI_BASE_URL",
      "OPENROUTER_EMBEDDING_MODEL", "OPENROUTER_EMBEDDING_DIMENSIONS",
    ]) delete process.env[k];
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("OpenAI sends a width that shortens a known model", async () => {
    process.env["OPENAI_EMBEDDING_MODEL"] = "text-embedding-3-large";
    process.env["OPENAI_EMBEDDING_DIMENSIONS"] = "1024";
    const spy = stubFetch(1024);
    await new OpenAIEmbeddingProvider("test-key").embed("x");
    expect(sentBody(spy).dimensions).toBe(1024);
  });

  it("OpenRouter sends a width that shortens a known model", async () => {
    process.env["OPENROUTER_EMBEDDING_MODEL"] = "openai/text-embedding-3-large";
    process.env["OPENROUTER_EMBEDDING_DIMENSIONS"] = "1024";
    const spy = stubFetch(1024);
    await new OpenRouterEmbeddingProvider("test-key").embed("x");
    expect(sentBody(spy).dimensions).toBe(1024);
  });

  it("omits the field when the width only declares an unknown model's native size", async () => {
    process.env["OPENAI_EMBEDDING_MODEL"] = "nomic-embed-text";
    process.env["OPENAI_EMBEDDING_DIMENSIONS"] = "768";
    const spy = stubFetch(768);
    await new OpenAIEmbeddingProvider("test-key").embed("x");
    expect(sentBody(spy)).not.toHaveProperty("dimensions");
  });

  it("sends a width that shortens a Matryoshka model named with a provider prefix (upstream PR #1369)", async () => {
    process.env["OPENAI_EMBEDDING_MODEL"] = "Qwen/Qwen3-Embedding-8B";
    process.env["OPENAI_EMBEDDING_DIMENSIONS"] = "1024";
    const spy = stubFetch(1024);
    await new OpenAIEmbeddingProvider("test-key").embed("x");
    expect(sentBody(spy).dimensions).toBe(1024);
  });

  it("omits the field at a known model's native width", async () => {
    const spy = stubFetch(1536);
    await new OpenAIEmbeddingProvider("test-key").embed("x");
    expect(sentBody(spy)).not.toHaveProperty("dimensions");
  });
});
