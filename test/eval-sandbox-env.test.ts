import { describe, it, expect, afterEach } from "vitest";
import { sandboxEnv } from "../eval/runner/sandbox.js";

const KEYS = ["AGENTMEMORY_LOCAL_EMBEDDING_MODEL", "AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS"];

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
});
