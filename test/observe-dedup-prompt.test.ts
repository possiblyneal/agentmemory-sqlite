import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function observePayload(hookType: string, data: unknown) {
  return {
    sessionId: "ses_dedup_test",
    project: "/home/user/myrepo",
    cwd: "/home/user/myrepo",
    hookType,
    timestamp: new Date().toISOString(),
    data,
  };
}

describe("observe dedup for hooks without tool_input (#1173)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("records consecutive prompt_submit observations with different prompts", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, new DedupMap());

    const first = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", { prompt: "ship the helm chart" }),
    )) as { observationId?: string; deduplicated?: boolean };
    const second = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", { prompt: "now fix the failing test" }),
    )) as { observationId?: string; deduplicated?: boolean };

    expect(first.observationId).toBeTruthy();
    expect(second.deduplicated).toBeUndefined();
    expect(second.observationId).toBeTruthy();
  });

  it("records two prompt_submit observations whose data is distinct primitive strings", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, new DedupMap());

    const first = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", "ship the helm chart"),
    )) as { observationId?: string; deduplicated?: boolean };
    const second = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", "now fix the failing test"),
    )) as { observationId?: string; deduplicated?: boolean };

    expect(first.observationId).toBeTruthy();
    expect(second.deduplicated).toBeUndefined();
    expect(second.observationId).toBeTruthy();
  });

  it("still dedups an identical prompt_submit within the TTL window", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, new DedupMap());

    const payload = { prompt: "ship the helm chart" };
    const first = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", payload),
    )) as { observationId?: string };
    const second = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", payload),
    )) as { deduplicated?: boolean };

    expect(first.observationId).toBeTruthy();
    expect(second.deduplicated).toBe(true);
  });

  async function setup() {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk({ looseTrigger: true });
    registerObserveFunction(sdk as never, mockKV() as never, new DedupMap());
    return (hookType: string, data: unknown) =>
      sdk.trigger("mem::observe", observePayload(hookType, data)) as Promise<{
        observationId?: string;
        deduplicated?: boolean;
      }>;
  }

  it("stores a rerun of the same tool input whose output changed", async () => {
    const observe = await setup();
    const call = (out: string) =>
      observe("post_tool_use", {
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_output: out,
      });
    const first = await call("1 failed");
    const second = await call("all passed");

    expect(first.observationId).toBeTruthy();
    expect(second.deduplicated).toBeUndefined();
    expect(second.observationId).toBeTruthy();
  });

  it("dedups a rerun with the same input and the same output", async () => {
    const observe = await setup();
    const data = {
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_output: "a.txt",
    };
    const first = await observe("post_tool_use", data);
    const second = await observe("post_tool_use", data);

    expect(first.observationId).toBeTruthy();
    expect(second.deduplicated).toBe(true);
  });

  it("keeps a post_tool_use and a post_tool_failure with the same input", async () => {
    const observe = await setup();
    const input = { command: "npm test" };
    const first = await observe("post_tool_use", {
      tool_name: "Bash",
      tool_input: input,
    });
    const second = await observe("post_tool_failure", {
      tool_name: "Bash",
      tool_input: input,
    });

    expect(first.observationId).toBeTruthy();
    expect(second.deduplicated).toBeUndefined();
    expect(second.observationId).toBeTruthy();
  });
});
