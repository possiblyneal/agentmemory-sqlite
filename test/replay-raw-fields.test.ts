import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mockKV } from "./helpers/mocks.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerReplayFunctions } from "../src/functions/replay.js";

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, fn: Function) => {
      fns.set(typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id, fn);
    },
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = fns.get(id);
      return fn ? fn(payload) : null;
    },
  };
}

type Event = { toolInput?: unknown; body?: string; kind?: string };

describe("replay after synthetic compression", () => {
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    registerReplayFunctions(sdk as never, kv as never);
  });

  async function replayEvents(): Promise<Event[]> {
    const out = (await sdk.trigger("mem::replay::load", { sessionId: "s1" })) as {
      timeline: { events: Event[] };
    };
    return out.timeline.events;
  }

  const observe = (hookType: string, data: unknown) =>
    sdk.trigger("mem::observe", {
      sessionId: "s1",
      hookType,
      timestamp: new Date().toISOString(),
      data,
    });

  it("shows the raw toolInput", async () => {
    await observe("post_tool_use", {
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_output: "ok",
    });
    const events = await replayEvents();
    expect(events[0].toolInput).toBe(JSON.stringify({ command: "ls -la" }));
  });

  it("shows the assistantResponse of a finished subagent", async () => {
    await observe("subagent_stop", { agent_id: "a1", last_message: "All done, merged." });
    const events = await replayEvents();
    expect(events[0].kind).toBe("response");
    expect(events[0].body).toBe("All done, merged.");
  });

  it("scrubs secrets from the stored raw fields", async () => {
    await observe("post_tool_use", {
      tool_name: "Bash",
      tool_input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'" },
    });
    const events = await replayEvents();
    expect(String(events[0].toolInput)).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(String(events[0].toolInput)).toContain("[REDACTED_SECRET]");
  });

  it("caps oversized raw fields", async () => {
    await observe("post_tool_use", {
      tool_name: "Write",
      tool_input: { content: "x".repeat(50_000) },
    });
    const events = await replayEvents();
    expect(String(events[0].toolInput).length).toBeLessThan(4200);
  });
});
