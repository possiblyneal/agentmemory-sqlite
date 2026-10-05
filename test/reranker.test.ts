import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@huggingface/transformers", () => {
  throw new Error("not installed");
});

import { rerank, isRerankerAvailable } from "../src/state/reranker.js";

describe("reranker", () => {
  it("returns results unchanged when @huggingface/transformers is unavailable", async () => {
    const results = [
      {
        observation: {
          id: "o1",
          title: "First",
          narrative: "First result",
        },
        bm25Score: 0.5,
        vectorScore: 0.6,
        graphScore: 0,
        combinedScore: 0.8,
        sessionId: "s1",
      },
      {
        observation: {
          id: "o2",
          title: "Second",
          narrative: "Second result",
        },
        bm25Score: 0.3,
        vectorScore: 0.4,
        graphScore: 0,
        combinedScore: 0.5,
        sessionId: "s1",
      },
    ] as any;

    const reranked = await rerank("test query", results);
    expect(reranked).toEqual(results);
  });

  it("isRerankerAvailable returns false when not loaded", () => {
    expect(isRerankerAvailable()).toBe(false);
  });

  it("handles single result gracefully", async () => {
    const results = [
      {
        observation: { id: "o1", title: "Only" },
        combinedScore: 1.0,
      },
    ] as any;

    const reranked = await rerank("query", results);
    expect(reranked).toHaveLength(1);
  });

  it("handles empty results", async () => {
    const reranked = await rerank("query", []);
    expect(reranked).toHaveLength(0);
  });
});

describe("reranker with loaded pipeline", () => {
  afterEach(() => {
    vi.doUnmock("@huggingface/transformers");
    vi.resetModules();
  });

  function wordTokenizer(maxLength: number) {
    return Object.assign(
      vi.fn((queries: string[], opts: { text_pair: string[] }) => ({
        queries,
        passages: opts.text_pair,
      })),
      {
        model_max_length: maxLength,
        encode: (text: string) => text.split(" ").filter(Boolean),
        decode: (ids: string[]) => ids.join(" "),
      },
    );
  }

  async function loadReranker(
    tokenizer: ReturnType<typeof wordTokenizer>,
    model: (inputs: { passages: string[] }) => Promise<unknown>,
  ) {
    const env: Record<string, unknown> = {};
    vi.doMock("@huggingface/transformers", () => ({
      env,
      AutoTokenizer: { from_pretrained: () => Promise.resolve(tokenizer) },
      AutoModelForSequenceClassification: { from_pretrained: () => Promise.resolve(model) },
    }));
    vi.resetModules();
    const { rerank } = await import("../src/state/reranker.js");
    return { rerank, env };
  }

  it("scores each query/passage pair and reorders by the cross-encoder logit", async () => {
    const tokenizer = wordTokenizer(512);
    const model = vi.fn(async (inputs: { passages: string[] }) => ({
      logits: { data: Float32Array.from(inputs.passages.map((p) => (p.includes("First") ? 2 : -9))) },
    }));
    const { rerank, env } = await loadReranker(tokenizer, model);

    const results = [
      { observation: { id: "o2", title: "Second", narrative: "" }, combinedScore: 0.9 },
      { observation: { id: "o1", title: "First", narrative: "" }, combinedScore: 0.5 },
    ] as any;

    const reranked = await rerank("query", results);

    expect(tokenizer.mock.calls[0][0]).toEqual(["query", "query"]);
    expect(reranked.map((r) => r.observation.id)).toEqual(["o1", "o2"]);
    expect(reranked[0].combinedScore).toBeGreaterThan(0.8);
    expect(reranked[1].combinedScore).toBeLessThan(0.01);
    expect(env["cacheDir"]).toMatch(/models$/);
  });

  it("trims only the passage so the query and closing separator fit the model", async () => {
    const tokenizer = wordTokenizer(8);
    const model = vi.fn(async (inputs: { passages: string[] }) => ({
      logits: { data: Float32Array.from(inputs.passages.map(() => 0)) },
    }));
    const { rerank } = await loadReranker(tokenizer, model);

    await rerank("two words", [
      { observation: { id: "o1", title: "a", narrative: "b c d e f g" }, combinedScore: 1 },
      { observation: { id: "o2", title: "short", narrative: "" }, combinedScore: 0.5 },
    ] as any);

    expect(tokenizer.mock.calls[0][1].text_pair).toEqual(["a b c", "short "]);
  });

  it("returns results unreranked and warns once when scoring fails", async () => {
    const tokenizer = wordTokenizer(512);
    const model = vi.fn(async () => {
      throw new Error("inference failed");
    });
    const { rerank } = await loadReranker(tokenizer, model);
    const { logger } = await import("../src/logger.js");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const results = [
      { observation: { id: "o1", title: "A", narrative: "" }, combinedScore: 0.9 },
      { observation: { id: "o2", title: "B", narrative: "" }, combinedScore: 0.5 },
    ] as any;

    expect(await rerank("query", results)).toBe(results);
    await rerank("query", results);

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
