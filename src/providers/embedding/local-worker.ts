import { parentPort, workerData } from "node:worker_threads";
import { configureTransformers } from "../transformers-env.js";

interface WorkerConfig {
  modelId: string;
  dtype: "q4" | "q8";
}

interface EmbedRequest {
  id: number;
  texts: string[];
  pooling: "cls" | "mean";
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

const port = parentPort!;
const config = workerData as WorkerConfig;

async function loadExtractor(): Promise<FeatureExtractor> {
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
  return (await transformers.pipeline("feature-extraction", config.modelId, {
    dtype: config.dtype,
  })) as unknown as FeatureExtractor;
}

try {
  const extractor = await loadExtractor();
  port.on("message", async (request: EmbedRequest) => {
    try {
      const output = await extractor(request.texts, { pooling: request.pooling, normalize: true });
      const vectors = new Float32Array(output.data);
      port.postMessage(
        { type: "result", id: request.id, vectors, dimensions: output.dims[output.dims.length - 1] },
        [vectors.buffer],
      );
    } catch (err) {
      port.postMessage({
        type: "error",
        id: request.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
  port.postMessage({ type: "ready" });
} catch (err) {
  port.postMessage({
    type: "load-error",
    message: err instanceof Error ? err.message : String(err),
  });
}
