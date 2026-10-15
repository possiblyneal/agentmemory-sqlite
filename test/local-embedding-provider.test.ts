import { readFileSync } from "node:fs";
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

  it("loads the model once when a warm-up and an embed overlap", async () => {
    const { pipeline } = mockSuccessModule();
    const { LocalEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/local.js"
    );
    const provider = new Fresh();
    await Promise.all([provider.warm(), provider.embed("hello")]);
    await provider.embed("again");
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it("retries the load on the next embed after a failed one", async () => {
    const { pipeline, extractor } = mockSuccessModule();
    pipeline.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const { LocalEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/local.js"
    );
    const provider = new Fresh();
    await expect(provider.warm()).rejects.toThrow("offline");
    await provider.embed("hello");
    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(extractor).toHaveBeenCalledTimes(1);
  });
});

describe("warmInBackground", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("loads the boot provider's model before any embed, and the embed reuses it", async () => {
    vi.stubEnv("EMBEDDING_PROVIDER", "local");
    const pipeline = vi.fn(async () =>
      vi.fn(async (texts: string[]) => ({ tolist: () => texts.map(() => new Array(384).fill(0)) })),
    );
    vi.doMock("@huggingface/transformers", () => ({ env: {}, pipeline }));
    vi.resetModules();
    const { createEmbeddingProvider, warmInBackground } = await import(
      "../src/providers/embedding/index.js"
    );
    const provider = createEmbeddingProvider()!;

    warmInBackground(provider);
    await vi.waitFor(() => expect(pipeline).toHaveBeenCalledTimes(1));
    await provider.embed("first search");
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it("logs a failed warm-up instead of rejecting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { warmInBackground } = await import("../src/providers/embedding/index.js");
    warmInBackground({
      name: "fake",
      dimensions: 3,
      embed: async () => new Float32Array(3),
      embedBatch: async () => [],
      warm: () => Promise.reject(new Error("model missing")),
    });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("model missing")),
    );
    warn.mockRestore();
  });

  it("starts at boot once the daemon is ready", () => {
    const boot = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    const ready = boot.indexOf("sdk.setReady();");
    const warm = boot.indexOf("warmInBackground(embeddingProvider);");
    expect(ready).toBeGreaterThan(-1);
    expect(warm).toBeGreaterThan(ready);
  });

  it("does nothing without a provider or a warm-up", async () => {
    const { warmInBackground } = await import("../src/providers/embedding/index.js");
    expect(() => warmInBackground(null)).not.toThrow();
    expect(() =>
      warmInBackground({
        name: "remote",
        dimensions: 3,
        embed: async () => new Float32Array(3),
        embedBatch: async () => [],
      }),
    ).not.toThrow();
  });
});
