import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

import { registerApiTriggers } from "../src/triggers/api.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async () => {},
    update: async () => {},
    list: async <T>(): Promise<T[]> => [],
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    fns,
    registerFunction: (id: string, h: Function) => {
      fns.set(id, h);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload),
  };
}

describe("POST /agentmemory/summarize", () => {
  it("forwards only sessionId and a boolean force to mem::summarize", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as any, mockKV() as any);
    const received: unknown[] = [];
    sdk.registerFunction("mem::summarize", async (payload: unknown) => {
      received.push(payload);
      return { success: true };
    });
    const route = sdk.fns.get("api::summarize")!;

    await route({ body: { sessionId: "ses_1", force: true, extra: "dropped" } });
    await route({ body: { sessionId: "ses_1" } });
    await route({ body: { sessionId: "ses_1", force: "yes" } });

    expect(received).toEqual([
      { sessionId: "ses_1", force: true },
      { sessionId: "ses_1", force: false },
      { sessionId: "ses_1", force: false },
    ]);
  });
});
