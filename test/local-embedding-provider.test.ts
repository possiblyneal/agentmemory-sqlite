import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { LocalEmbeddingProvider } from "../src/providers/embedding/local.js";

const workerUrl = new URL("./fixtures/fake-embed-worker.mjs", import.meta.url);
const make = () => new LocalEmbeddingProvider({ workerUrl });

afterEach(() => vi.unstubAllEnvs());

describe("LocalEmbeddingProvider (worker thread)", () => {
  it("surfaces a load failure, such as the missing package, as a failed embed", async () => {
    vi.stubEnv(
      "FAKE_EMBED_LOAD_ERROR",
      "Install @huggingface/transformers for local embeddings: npm install @huggingface/transformers",
    );
    await expect(make().embed("hello")).rejects.toThrow(
      "Install @huggingface/transformers for local embeddings",
    );
  });

  it("returns one Float32Array per text, in order", async () => {
    const vecs = await make().embedBatch(["a", "bbb", "cc"]);
    expect(vecs.every((v) => v instanceof Float32Array && v.length === 4)).toBe(true);
    expect(vecs.map((v) => v[0])).toEqual([1, 3, 2]);
  });

  it("keeps concurrent calls apart", async () => {
    const provider = make();
    const [x, y] = await Promise.all([provider.embed("xx"), provider.embedBatch(["yyyy"])]);
    expect(x[0]).toBe(2);
    expect(y[0][0]).toBe(4);
  });

  it("rejects the pending call when the worker crashes, and the next call starts a fresh worker", async () => {
    const provider = make();
    const first = await provider.embed("ok");
    const [crashed, sibling] = await Promise.allSettled([provider.embed("crash"), provider.embed("other")]);
    expect(crashed.status).toBe("rejected");
    expect(sibling.status).toBe("rejected");
    expect((crashed as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    const again = await provider.embed("ok");
    expect(again[0]).toBe(2);
    expect(again[3]).not.toBe(first[3]);
  });

  it("keeps the main event loop responsive while the worker is busy", async () => {
    const provider = make();
    await provider.warm();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = Date.now();
    await provider.embed("busy");
    clearInterval(timer);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(ticks).toBeGreaterThan(10);
  });

  it("reuses one worker for a warm-up and the embeds after it", async () => {
    const provider = make();
    await Promise.all([provider.warm(), provider.embed("hello")]);
    const [a, b] = [await provider.embed("one"), await provider.embed("two")];
    expect(a[3]).toBe(b[3]);
  });

  it("pools BGE v1.5 by CLS and prefixes its queries, not its documents", async () => {
    vi.stubEnv("AGENTMEMORY_LOCAL_EMBEDDING_MODEL", "Xenova/bge-small-en-v1.5");
    vi.stubEnv("AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS", "384");
    const provider = make();
    const [doc] = await provider.embedBatch(["a document"]);
    const query = await provider.embedQuery("a query");
    expect(doc[0]).toBe("a document".length);
    expect(doc[1]).toBe(1);
    expect(query[0]).toBe("Represent this sentence for searching relevant passages: a query".length);
    expect(provider.vectorSpace).toBe("local:Xenova/bge-small-en-v1.5:cls:384");
  });

  it("runs EmbeddingGemma 2 at q4 with its search-task prefix on both sides", async () => {
    vi.stubEnv("AGENTMEMORY_LOCAL_EMBEDDING_MODEL", "onnx-community/embeddinggemma-2-ONNX");
    vi.stubEnv("AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS", "768");
    const provider = make();
    const [doc] = await provider.embedBatch(["a document"]);
    const query = await provider.embedQuery("a query");
    expect(doc[0]).toBe("title: none | text: a document".length);
    expect(doc[2]).toBe(1);
    expect(query[0]).toBe("task: search result | query: a query".length);
    expect(provider.vectorSpace).toBe(
      "local:onnx-community/embeddinggemma-2-ONNX:mean:768:doc=title: none | text: ",
    );
  });

  it("keeps mean pooling and unprefixed queries for other models", async () => {
    const provider = make();
    const query = await provider.embedQuery("a query");
    expect(query[0]).toBe("a query".length);
    expect(query[1]).toBe(0);
    expect(provider.vectorSpace).toBe("local:Xenova/all-MiniLM-L6-v2:mean:384");
  });

  it("honors a model and dimensions override", () => {
    vi.stubEnv("AGENTMEMORY_LOCAL_EMBEDDING_MODEL", "Xenova/bge-small-en-v1.5");
    vi.stubEnv("AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS", "512");
    expect(make().dimensions).toBe(512);
  });

  it("refuses a custom model without declared dimensions", () => {
    vi.stubEnv("AGENTMEMORY_LOCAL_EMBEDDING_MODEL", "Xenova/bge-small-en-v1.5");
    vi.stubEnv("AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS", "");
    expect(() => make()).toThrow("AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS");
  });
});

describe("warmInBackground", () => {
  afterEach(() => vi.unstubAllEnvs());

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
