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

  it("scores each query/passage pair and reorders by the cross-encoder logit", async () => {
    const tokenizer = vi.fn(
      (queries: string[], opts: { text_pair: string[] }) => ({ queries, passages: opts.text_pair }),
    );
    const model = vi.fn(async (inputs: { passages: string[] }) => ({
      logits: { data: Float32Array.from(inputs.passages.map((p) => (p.includes("First") ? 2 : -9))) },
    }));
    const env: Record<string, unknown> = {};
    vi.doMock("@huggingface/transformers", () => ({
      env,
      AutoTokenizer: { from_pretrained: () => Promise.resolve(tokenizer) },
      AutoModelForSequenceClassification: { from_pretrained: () => Promise.resolve(model) },
    }));
    vi.resetModules();
    const { rerank } = await import("../src/state/reranker.js");

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
});
