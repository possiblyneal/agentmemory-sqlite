import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.doUnmock("@huggingface/transformers");
  vi.resetModules();
});

describe("ClipEmbeddingProvider (package unavailable)", () => {
  it("throws clean install hint when @huggingface/transformers is missing", async () => {
    vi.doMock("@huggingface/transformers");
    vi.resetModules();
    const { ClipEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/clip.js"
    );
    await expect(new Fresh().embed("hello")).rejects.toThrow(
      "Install @huggingface/transformers for CLIP embeddings",
    );
  });
});

describe("ClipEmbeddingProvider (with loaded pipeline)", () => {
  function mockSuccessModule() {
    const tokenizer = vi.fn((texts: string[]) => ({ input_ids: texts }));
    const textModel = vi.fn(async (inputs: { input_ids: string[] }) => ({
      text_embeds: { tolist: () => inputs.input_ids.map(() => [3, 4]) },
    }));
    const AutoTokenizer = { from_pretrained: vi.fn(async () => tokenizer) };
    const CLIPTextModelWithProjection = {
      from_pretrained: vi.fn(async () => textModel),
    };
    const imageExtractor = vi.fn(async () => ({
      tolist: () => [[0.3, 0.4]],
      data: new Float32Array([0.3, 0.4]),
    }));
    const fromBlob = vi.fn(async () => ({}));
    const pipeline = vi.fn((task: string) => {
      if (task === "image-feature-extraction") return Promise.resolve(imageExtractor);
      return Promise.reject(new Error(`unmocked task: ${task}`));
    });
    vi.doMock("@huggingface/transformers", () => ({
      env: {},
      AutoTokenizer,
      CLIPTextModelWithProjection,
      pipeline,
      RawImage: { fromBlob },
    }));
    vi.resetModules();
    return { pipeline, AutoTokenizer, CLIPTextModelWithProjection, imageExtractor, fromBlob };
  }

  it("encodes text with the CLIP text tower and returns a normalized Float32Array", async () => {
    const { pipeline, AutoTokenizer, CLIPTextModelWithProjection } = mockSuccessModule();
    const { ClipEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/clip.js"
    );
    const vec = await new Fresh().embed("hello");

    expect(pipeline).not.toHaveBeenCalledWith(
      "feature-extraction",
      expect.anything(),
      expect.anything(),
    );
    expect(AutoTokenizer.from_pretrained).toHaveBeenCalledWith("Xenova/clip-vit-base-patch32");
    expect(CLIPTextModelWithProjection.from_pretrained).toHaveBeenCalledWith(
      "Xenova/clip-vit-base-patch32",
      { dtype: "q8" },
    );
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec[0]).toBeCloseTo(0.6);
    expect(vec[1]).toBeCloseTo(0.8);
  });

  it("embedBatch returns one Float32Array per input", async () => {
    mockSuccessModule();
    const { ClipEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/clip.js"
    );
    const vecs = await new Fresh().embedBatch(["a", "b"]);

    expect(vecs).toHaveLength(2);
    for (const v of vecs) expect(v).toBeInstanceOf(Float32Array);
  });

  it("embedImage loads image pipeline with dtype: q8 and decodes data: URL", async () => {
    const { pipeline, fromBlob } = mockSuccessModule();
    const { ClipEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/clip.js"
    );
    const vec = await new Fresh().embedImage("data:image/png;base64,AAAA");

    expect(pipeline).toHaveBeenCalledWith(
      "image-feature-extraction",
      "Xenova/clip-vit-base-patch32",
      { dtype: "q8" },
    );
    expect(fromBlob).toHaveBeenCalled();
    expect(vec).toBeInstanceOf(Float32Array);
  });

  it("accepts custom model ID via constructor", async () => {
    const { AutoTokenizer, CLIPTextModelWithProjection } = mockSuccessModule();
    const { ClipEmbeddingProvider: Fresh } = await import(
      "../src/providers/embedding/clip.js"
    );
    await new Fresh("Xenova/clip-vit-large-patch14").embed("hello");

    expect(AutoTokenizer.from_pretrained).toHaveBeenCalledWith("Xenova/clip-vit-large-patch14");
    expect(CLIPTextModelWithProjection.from_pretrained).toHaveBeenCalledWith(
      "Xenova/clip-vit-large-patch14",
      { dtype: "q8" },
    );
  });
});
