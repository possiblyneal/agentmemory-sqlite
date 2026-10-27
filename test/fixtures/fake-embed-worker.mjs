import { parentPort, workerData, threadId } from "node:worker_threads";

if (process.env.FAKE_EMBED_LOAD_ERROR) {
  parentPort.postMessage({ type: "load-error", message: process.env.FAKE_EMBED_LOAD_ERROR });
} else {
  parentPort.on("message", ({ id, texts, pooling }) => {
    if (texts.includes("crash")) process.exit(3);
    if (texts.includes("busy")) {
      const until = Date.now() + 300;
      while (Date.now() < until);
    }
    const vectors = new Float32Array(texts.length * 4);
    texts.forEach((text, i) => {
      vectors.set([text.length, pooling === "cls" ? 1 : 0, workerData.dtype === "q4" ? 1 : 0, threadId], i * 4);
    });
    parentPort.postMessage({ type: "result", id, vectors, dimensions: 4 }, [vectors.buffer]);
  });
  parentPort.postMessage({ type: "ready" });
}
