import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerObserveFunction } from "../src/functions/observe.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async (scope: string, key: string) => store.get(scope)?.get(key) ?? null,
    set: async (scope: string, key: string, data: unknown) => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async () => {},
    update: async () => ({}),
    list: async (scope: string) => Array.from(store.get(scope)?.values() ?? []),
  };
}

describe("mem::observe stream writes", () => {
  it("writes only to the viewer group, never a per-Session group", async () => {
    const fns = new Map<string, Function>();
    const streamGroups: string[] = [];
    const sdk = {
      registerFunction: (id: string, fn: Function) => fns.set(id, fn),
      registerTrigger: () => {},
      trigger: async (input: { function_id: string; payload?: any }) => {
        if (input.function_id.startsWith("stream::")) streamGroups.push(input.payload.group_id);
        return fns.get(input.function_id)?.(input.payload) ?? null;
      },
    };
    registerObserveFunction(sdk as never, mockKV() as never, undefined, 100);
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        sessionId: "ses_stream",
        hookType: "post_tool_use",
        timestamp: "2026-05-01T00:00:00Z",
        data: { tool_name: "Read", tool_input: { file_path: "a.ts" } },
      },
    });
    expect(streamGroups.length).toBeGreaterThan(0);
    expect(streamGroups.every((g) => g === "viewer")).toBe(true);
  });
});
