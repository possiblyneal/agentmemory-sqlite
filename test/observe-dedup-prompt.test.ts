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

  it.each(["post_tool_use", "post_tool_failure"])("keeps image-like execution metadata out of image capture for %s", async (hook) => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { KV } = await import("../src/state/schema.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    for (const field of ["agent_id", "agent_type"]) {
      const value = "iVBORw0KGgo-reader";
      const result = await sdk.trigger("mem::observe", observePayload(hook, {
        tool_name: "Read", tool_input: { file_path: "a" }, tool_output: "plain text", [field]: value,
      })) as { observationId: string };
      const observation = await kv.get<Record<string, unknown>>(KV.observations("ses_dedup_test"), result.observationId);
      expect(observation?.[field === "agent_id" ? "executionAgentId" : "executionAgentType"]).toBe(value);
      expect(observation?.imageData).toBeUndefined();
      expect(observation?.modality).not.toBe("image");
      expect(observation?.modality).not.toBe("mixed");
    }
  });

  it("still detects explicit images alongside execution metadata", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { KV } = await import("../src/state/schema.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    const result = await sdk.trigger("mem::observe", observePayload("post_tool_use", {
      tool_name: "Read", tool_input: {}, tool_output: { image_path: "/synthetic/image.png" },
      agent_id: "iVBORw0KGgo-agent", agent_type: "iVBORw0KGgo-reader",
    })) as { observationId: string };
    const observation = await kv.get<Record<string, unknown>>(KV.observations("ses_dedup_test"), result.observationId);
    expect(observation).toMatchObject({ modality: "mixed", executionAgentId: "iVBORw0KGgo-agent", executionAgentType: "iVBORw0KGgo-reader" });
  });

  it("retains tool execution attribution in the captured observation", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { registerTimelineFunction } = await import("../src/functions/timeline.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    registerTimelineFunction(sdk as never, kv as never);
    const payload = observePayload("post_tool_use", { tool_name: "Read", tool_input: { file_path: "a" }, agent_id: "one", agent_type: "Explore" });
    await sdk.trigger("mem::observe", payload);
    const result = await sdk.trigger("mem::timeline", { anchor: payload.timestamp }) as { entries: Array<{ observation: unknown }> };
    expect(result.entries[0].observation).toMatchObject({ executionAgentId: "one", executionAgentType: "Explore" });
    expect(result.entries[0].observation).not.toHaveProperty("agentId");
  });

  it.each([
    ["agent_id", "executionAgentId", "worker <private>secret</private>"],
    ["agent_type", "executionAgentType", `<private>${"x".repeat(263)}</private>`],
  ])("omits %s when sanitization changes its identity", async (field, storedField, value) => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { registerTimelineFunction } = await import("../src/functions/timeline.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    registerTimelineFunction(sdk as never, kv as never);
    const payload = observePayload("post_tool_use", { tool_name: "Read", tool_input: {}, [field]: value });
    await sdk.trigger("mem::observe", payload);
    const result = await sdk.trigger("mem::timeline", { anchor: payload.timestamp }) as { entries: Array<{ observation: unknown }> };
    expect(result.entries[0].observation).not.toHaveProperty(storedField);
  });

  it("omits missing or invalid execution attribution", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { registerTimelineFunction } = await import("../src/functions/timeline.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    registerTimelineFunction(sdk as never, kv as never);
    const payload = observePayload("post_tool_failure", { tool_name: "Read", tool_input: {}, agent_id: "x".repeat(257), agent_type: 42 });
    await sdk.trigger("mem::observe", payload);
    const result = await sdk.trigger("mem::timeline", { anchor: payload.timestamp }) as { entries: Array<{ observation: unknown }> };
    expect(result.entries[0].observation).not.toHaveProperty("executionAgentId");
    expect(result.entries[0].observation).not.toHaveProperty("executionAgentType");
  });

  it.each(["post_tool_use", "post_tool_failure"])("keeps interleaved identical %s calls from distinct subagents", async (hook) => {
    const observe = await setup();
    const data = { tool_name: "Bash", tool_input: { command: "ls" }, tool_output: "a.txt", agent_type: "Explore" };
    const first = await observe(hook, { ...data, agent_id: "one" });
    const second = await observe(hook, { ...data, agent_id: "two" });
    const repeated = await observe(hook, { ...data, agent_id: "one" });
    expect(first.observationId).toBeTruthy();
    expect(second.observationId).toBeTruthy();
    expect(repeated.deduplicated).toBe(true);
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

  it("records two long prompts that share their first 600 characters (#439)", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, new DedupMap());

    const shared = "Review the failing deploy. ".repeat(23);
    const first = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", { prompt: shared + "Then fix the helm chart." }),
    )) as { observationId?: string; deduplicated?: boolean };
    const second = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", { prompt: shared + "Then roll back the release." }),
    )) as { observationId?: string; deduplicated?: boolean };

    expect(first.observationId).toBeTruthy();
    expect(second.deduplicated).toBeUndefined();
    expect(second.observationId).toBeTruthy();
  });
});
