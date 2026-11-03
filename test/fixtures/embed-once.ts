import { LocalEmbeddingProvider } from "../../src/providers/embedding/local.js";

const provider = new LocalEmbeddingProvider({ workerUrl: new URL("./fake-embed-worker.mjs", import.meta.url) });
const [vector] = await provider.embedBatch(["abc"]);
console.log("embedded", vector[0]);
