import type { EmbeddingProvider } from "../../types.js";
import { getEnvVar } from "../../config.js";
import { configureTransformers } from "../transformers-env.js";
import { resolveDimensions } from "./_dimensions.js";
import {
  BGE_V1_5,
  EMBEDDING_GEMMA_2,
  retrievalProfileFor,
  withDocumentPrefix,
  type RetrievalProfile,
} from "./_retrieval.js";

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_DIMENSIONS = "384";

interface ModelProfile {
  pooling: "cls" | "mean";
  dtype: "q4" | "q8";
}

const DEFAULT_PROFILE: ModelProfile = { pooling: "mean", dtype: "q8" };

// Pooling is what each model card prescribes: BGE v1.5 pools by CLS.
// EmbeddingGemma runs q4 because q8 is four times slower per query on CPU.
const MODEL_PROFILES: Array<[RegExp, ModelProfile]> = [
  [BGE_V1_5, { pooling: "cls", dtype: "q8" }],
  [EMBEDDING_GEMMA_2, { pooling: "mean", dtype: "q4" }],
];

function profileFor(modelId: string): ModelProfile {
  return MODEL_PROFILES.find(([pattern]) => pattern.test(modelId))?.[1] ?? DEFAULT_PROFILE;
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly dimensions: number;
  readonly vectorSpace: string;
  private readonly modelId: string;
  private readonly profile: ModelProfile;
  private readonly retrieval: RetrievalProfile;
  private extractor: Promise<FeatureExtractor> | null = null;

  constructor() {
    this.modelId = getEnvVar("AGENTMEMORY_LOCAL_EMBEDDING_MODEL") || DEFAULT_MODEL;
    this.dimensions = resolveDimensions(
      this.modelId,
      getEnvVar("AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS") ||
        (this.modelId === DEFAULT_MODEL ? DEFAULT_DIMENSIONS : undefined),
      "AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS",
    );
    this.profile = profileFor(this.modelId);
    this.retrieval = retrievalProfileFor(this.modelId);
    this.vectorSpace = withDocumentPrefix(
      `local:${this.modelId}:${this.profile.pooling}:${this.dimensions}`,
      this.retrieval,
    );
  }

  get minRelevantCosine(): number | undefined {
    return this.retrieval.minRelevantCosine;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [result] = await this.extract([this.retrieval.queryPrefix + text]);
    return result;
  }

  async warm(): Promise<void> {
    await this.getExtractor();
  }

  async embed(text: string): Promise<Float32Array> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return this.extract(texts.map((text) => this.retrieval.documentPrefix + text));
  }

  private async extract(texts: string[]): Promise<Float32Array[]> {
    const extractor = await this.getExtractor();
    const output = await extractor(texts, {
      pooling: this.profile.pooling,
      normalize: true,
    });
    return output.tolist().map((v) => new Float32Array(v));
  }

  private getExtractor(): Promise<FeatureExtractor> {
    this.extractor ??= this.loadExtractor().catch((err: unknown) => {
      this.extractor = null;
      throw err;
    });
    return this.extractor;
  }

  private async loadExtractor(): Promise<FeatureExtractor> {
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
    return (await transformers.pipeline("feature-extraction", this.modelId, {
      dtype: this.profile.dtype,
    })) as FeatureExtractor;
  }
}
