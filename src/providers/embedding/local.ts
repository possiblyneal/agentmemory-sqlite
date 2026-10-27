import type { EmbeddingProvider } from "../../types.js";
import { Worker } from "node:worker_threads";
import { getEnvVar, getModelCacheDir } from "../../config.js";
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

interface Pending {
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: Error) => void;
}

interface WorkerHandle {
  worker: Worker;
  ready: Promise<void>;
  pending: Map<number, Pending>;
}

export interface LocalEmbeddingOptions {
  workerUrl?: URL;
}

type WorkerMessage =
  | { type: "ready" }
  | { type: "load-error"; message: string }
  | { type: "error"; id: number; message: string }
  | { type: "result"; id: number; vectors: Float32Array; dimensions: number };

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly dimensions: number;
  readonly vectorSpace: string;
  private readonly modelId: string;
  private readonly profile: ModelProfile;
  private readonly retrieval: RetrievalProfile;
  private readonly workerUrl: URL;
  private handle: WorkerHandle | null = null;
  private nextId = 0;

  constructor(options: LocalEmbeddingOptions = {}) {
    this.workerUrl = options.workerUrl ?? new URL("./local-worker.mjs", import.meta.url);
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
    await this.ensureWorker().ready;
  }

  async embed(text: string): Promise<Float32Array> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return this.extract(texts.map((text) => this.retrieval.documentPrefix + text));
  }

  private extract(texts: string[]): Promise<Float32Array[]> {
    const handle = this.ensureWorker();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      handle.pending.set(id, { resolve, reject });
      handle.worker.postMessage({ id, texts, pooling: this.profile.pooling });
    });
  }

  private ensureWorker(): WorkerHandle {
    if (this.handle) return this.handle;
    const mirror = getEnvVar("HF_ENDPOINT");
    const worker = new Worker(this.workerUrl, {
      workerData: {
        modelId: this.modelId,
        dtype: this.profile.dtype,
        cacheDir: getModelCacheDir(),
        remoteHost: mirror ? (mirror.endsWith("/") ? mirror : `${mirror}/`) : null,
      },
    });
    worker.unref();
    const pending = new Map<number, Pending>();
    let markReady!: () => void;
    let failReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    ready.catch(() => {});
    const handle: WorkerHandle = { worker, ready, pending };
    this.handle = handle;

    const fail = (err: Error) => {
      if (this.handle === handle) this.handle = null;
      failReady(err);
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
      void worker.terminate();
    };
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "ready") return markReady();
      if (message.type === "load-error") return fail(new Error(message.message));
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.type === "error") return entry.reject(new Error(message.message));
      const { vectors, dimensions } = message;
      const out: Float32Array[] = [];
      for (let at = 0; at < vectors.length; at += dimensions) {
        out.push(vectors.slice(at, at + dimensions));
      }
      entry.resolve(out);
    });
    worker.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    worker.on("exit", (code) => fail(new Error(`Local embedding worker exited with code ${code}`)));
    return handle;
  }
}
