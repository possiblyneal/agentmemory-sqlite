import { describe, it, expect, afterEach } from "vitest";
import { sandboxEnv } from "../eval/runner/sandbox.js";

const GRAPH_KEYS = [
  "GRAPH_EXTRACTION_ENABLED",
  "GRAPH_EXTRACTION_BATCH_SIZE",
  "AGENTMEMORY_GRAPH_WEIGHT",
  "AGENTMEMORY_GRAPH_LEG",
];
const KEYS = ["AGENTMEMORY_LOCAL_EMBEDDING_MODEL", "AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS", ...GRAPH_KEYS];

describe("sandboxEnv", () => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("points the model cache outside the per-run HOME", () => {
    const env = sandboxEnv("/sb/instance-3/home", "/sb/instance-3/s.sqlite", "/sb/models", "local", false);
    expect(env.AGENTMEMORY_MODEL_CACHE_DIR).toBe("/sb/models");
    expect(env.HOME).toBe("/sb/instance-3/home");
  });

  it("forwards the shell's local embedding model and dimensions to a run that uses embeddings", () => {
    process.env.AGENTMEMORY_LOCAL_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
    process.env.AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS = "384";
    const env = sandboxEnv("/h", "/s.sqlite", "/m", "local", false);
    expect(env.AGENTMEMORY_LOCAL_EMBEDDING_MODEL).toBe("Xenova/bge-small-en-v1.5");
    expect(env.AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS).toBe("384");
  });

  it("keeps the local embedding model out of a run without embeddings", () => {
    process.env.AGENTMEMORY_LOCAL_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
    const env = sandboxEnv("/h", "/s.sqlite", "/m", "none", false);
    expect(env.AGENTMEMORY_LOCAL_EMBEDDING_MODEL).toBeUndefined();
  });

  it("forwards each graph setting the shell sets and leaves the unset ones absent", () => {
    for (const k of GRAPH_KEYS) delete process.env[k];
    process.env.GRAPH_EXTRACTION_ENABLED = "true";
    process.env.AGENTMEMORY_GRAPH_WEIGHT = "0.4";
    const env = sandboxEnv("/h", "/s.sqlite", "/m", "none", false);
    expect(env.GRAPH_EXTRACTION_ENABLED).toBe("true");
    expect(env.AGENTMEMORY_GRAPH_WEIGHT).toBe("0.4");
    expect("GRAPH_EXTRACTION_BATCH_SIZE" in env).toBe(false);
    expect("AGENTMEMORY_GRAPH_LEG" in env).toBe(false);
    process.env.GRAPH_EXTRACTION_BATCH_SIZE = "8";
    process.env.AGENTMEMORY_GRAPH_LEG = "on";
    const all = sandboxEnv("/h", "/s.sqlite", "/m", "none", false);
    expect(all.GRAPH_EXTRACTION_BATCH_SIZE).toBe("8");
    expect(all.AGENTMEMORY_GRAPH_LEG).toBe("on");
  });
});
