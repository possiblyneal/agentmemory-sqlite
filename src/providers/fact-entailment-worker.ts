import { basename, dirname, sep } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { AutoModelForSequenceClassification, AutoTokenizer, env } from "@huggingface/transformers";

const port = parentPort!;
const directory: string = workerData;
env.allowRemoteModels = false;
env.localModelPath = dirname(directory) + sep;
const modelId = basename(directory);
const options = { local_files_only: true };
const tokenizer = await AutoTokenizer.from_pretrained(modelId, options);
const model = await AutoModelForSequenceClassification.from_pretrained(modelId, {
  ...options,
  dtype: "q8",
  device: "cpu",
  session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
});
const config = model.config as typeof model.config & { id2label?: Record<number, string> };
const maxTokens = config.max_position_embeddings;
if (config.id2label?.[1] !== "entailment" || !Number.isInteger(maxTokens) || maxTokens < 1) {
  throw new Error("Unsupported Fact entailment model configuration");
}

async function entails(left: string, right: string): Promise<boolean> {
  const input = tokenizer(left, { text_pair: right, truncation: false });
  if ((input.input_ids.dims.at(-1) ?? Infinity) > maxTokens) return false;
  const { logits } = await model(input);
  const scores = Array.from(logits.data, Number);
  return scores.length === 3 && scores.every(Number.isFinite) && scores[1] > Math.max(scores[0], scores[2]);
}

port.on("message", async ([left, right]: [string, string]) => {
  port.postMessage(await entails(left, right) && await entails(right, left));
});
