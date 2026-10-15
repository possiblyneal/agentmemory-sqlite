import { describe, it, expect } from "vitest";
import { sandboxEnv } from "../eval/runner/sandbox.js";

describe("sandboxEnv", () => {
  it("points the model cache outside the per-run HOME", () => {
    const env = sandboxEnv("/sb/instance-3/home", "/sb/instance-3/s.sqlite", "/sb/models", "local", false);
    expect(env.AGENTMEMORY_MODEL_CACHE_DIR).toBe("/sb/models");
    expect(env.HOME).toBe("/sb/instance-3/home");
  });
});
