import type { EmbeddingProvider } from "../../types.js";
import { getEnvVar } from "../../config.js";
import { configureTransformers } from "../transformers-env.js";
import { resolveDimensions } from "./_dimensions.js";

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_DIMENSIONS = "384";
// BGE v1.5 is trained for CLS pooling, and its model card gives this
// instruction for short queries that retrieve longer passages.
const BGE_V1_5 = /bge-(small|base|large)-en-v1\.5$/;
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

type FeatureExtractor = (
  texts: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly dimensions: number;
  readonly vectorSpace: string;
  private readonly modelId: string;
  private readonly pooling: "cls" | "mean";
  private readonly queryPrefix: string;
  private extractor: FeatureExtractor | null = null;

  constructor() {
    this.modelId = getEnvVar("AGENTMEMORY_LOCAL_EMBEDDING_MODEL") || DEFAULT_MODEL;
    this.dimensions = resolveDimensions(
      this.modelId,
      getEnvVar("AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS") ||
        (this.modelId === DEFAULT_MODEL ? DEFAULT_DIMENSIONS : undefined),
      "AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS",
    );
    const isBge = BGE_V1_5.test(this.modelId);
    this.pooling = isBge ? "cls" : "mean";
    this.queryPrefix = isBge ? BGE_QUERY_PREFIX : "";
    this.vectorSpace = `local:${this.modelId}:${this.pooling}:${this.dimensions}`;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.embed(this.queryPrefix + text);
  }

  async embed(text: string): Promise<Float32Array> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const extractor = await this.getExtractor();
    const output = await extractor(texts, {
      pooling: this.pooling,
      normalize: true,
    });
    return output.tolist().map((v) => new Float32Array(v));
  }

  private async getExtractor() {
    if (this.extractor) return this.extractor;
    let transformers: typeof import("@huggingface/transformers");
    try {
      transformers = await import("@huggingface/transformers");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "Install @huggingface/transformers for local embeddings: npm install @huggingface/transformers",
        );
      }
      throw err;
    }
    configureTransformers(transformers);
    this.extractor = (await transformers.pipeline(
      "feature-extraction",
      this.modelId,
      { dtype: "q8" },
    )) as FeatureExtractor;
    return this.extractor;
  }
}
