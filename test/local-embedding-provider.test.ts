import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.doUnmock("@huggingface/transformers");
  vi.resetModules();
});

describe("LocalEmbeddingProvider (package unavailable)", () => {
  it("throws clean install hint when @huggingface/transformers is missing", async () => {
    vi.doMock("@huggingface/transformers");
    vi.resetModules();
    const { LocalEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/local.js"
    );
    await expect(new Fresh().embed("hello")).rejects.toThrow(
      "Install @huggingface/transformers for local embeddings",
    );
  });
});

describe("LocalEmbeddingProvider (with loaded pipeline)", () => {
  function mockSuccessModule() {
    const extractor = vi.fn(async (texts: string[]) => ({
      tolist: () => texts.map(() => [0.1, 0.2, 0.3]),
    }));
    const pipeline = vi.fn(() => Promise.resolve(extractor));
    const env: Record<string, unknown> = {};
    vi.doMock("@huggingface/transformers", () => ({ env, pipeline }));
    vi.resetModules();
    return { pipeline, extractor, env };
  }

  it("calls pipeline with dtype: q8, passes extractor opts, returns mapped Float32Array", async () => {
    const { pipeline, extractor } = mockSuccessModule();
    const { LocalEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/local.js"
    );
    const vec = await new Fresh().embed("hello");

    expect(pipeline).toHaveBeenCalledWith(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { dtype: "q8" },
    );
    expect(extractor).toHaveBeenCalledWith(["hello"], {
      pooling: "mean",
      normalize: true,
    });
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec).toEqual(new Float32Array([0.1, 0.2, 0.3]));
  });

  it("embedBatch returns one Float32Array per input text", async () => {
    mockSuccessModule();
    const { LocalEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/local.js"
    );
    const vecs = await new Fresh().embedBatch(["a", "b", "c"]);

    expect(vecs).toHaveLength(3);
    for (const v of vecs) expect(v).toBeInstanceOf(Float32Array);
  });

  it("sets the transformers cache dir and HF mirror once from env", async () => {
    vi.stubEnv("AGENTMEMORY_MODEL_CACHE_DIR", "/cache/models");
    vi.stubEnv("HF_ENDPOINT", "https://hf-mirror.example");
    const { env } = mockSuccessModule();
    const { LocalEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/local.js"
    );
    await new Fresh().embed("hello");
    expect(env["cacheDir"]).toBe("/cache/models");
    expect(env["remoteHost"]).toBe("https://hf-mirror.example/");
    vi.unstubAllEnvs();
  });

  it("defaults the cache dir under the data dir", async () => {
    vi.stubEnv("AGENTMEMORY_MODEL_CACHE_DIR", "");
    vi.stubEnv("XENOVA_CACHE_HOME", "");
    vi.stubEnv("AGENTMEMORY_DATA_DIR", "/data");
    const { env } = mockSuccessModule();
    const { LocalEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/local.js"
    );
    await new Fresh().embed("hello");
    expect(env["cacheDir"]).toBe("/data/models");
    vi.unstubAllEnvs();
  });

  it("honors a model and dimensions override", async () => {
    vi.stubEnv("AGENTMEMORY_LOCAL_EMBEDDING_MODEL", "Xenova/bge-small-en-v1.5");
    vi.stubEnv("AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS", "512");
    const { pipeline } = mockSuccessModule();
    const { LocalEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/local.js"
    );
    const provider = new Fresh();
    await provider.embed("hello");
    expect(provider.dimensions).toBe(512);
    expect(pipeline).toHaveBeenCalledWith(
      "feature-extraction",
      "Xenova/bge-small-en-v1.5",
      { dtype: "q8" },
    );
    vi.unstubAllEnvs();
  });

  it("refuses a custom model without declared dimensions", async () => {
    vi.stubEnv("AGENTMEMORY_LOCAL_EMBEDDING_MODEL", "Xenova/bge-small-en-v1.5");
    vi.stubEnv("AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS", "");
    mockSuccessModule();
    const { LocalEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/local.js"
    );
    expect(() => new Fresh()).toThrow("AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS");
    vi.unstubAllEnvs();
  });
});
