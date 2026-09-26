import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";

const SECRET = "bodyless-test-secret";

function mockKV() {
  return {
    get: async () => null,
    set: async <T>(_scope: string, _key: string, data: T) => data,
    delete: async () => {},
    list: async () => [],
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, h: Function) => {
      fns.set(id, h);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload),
    _fns: fns,
  };
}

let sdk: ReturnType<typeof mockSdk>;
const received = new Map<string, unknown>();

beforeEach(() => {
  sdk = mockSdk();
  registerApiTriggers(sdk as never, mockKV() as never, SECRET);
  received.clear();
  for (const id of ["mem::consolidate", "mem::patterns", "mem::generate-rules"]) {
    sdk._fns.set(id, (data: unknown) => {
      received.set(id, data);
      return { success: true };
    });
  }
});

// The engine hands a bodyless or non-JSON POST to the handler as body: null (#1008).
describe.each([
  ["api::consolidate", "mem::consolidate"],
  ["api::patterns", "mem::patterns"],
  ["api::generate-rules", "mem::generate-rules"],
])("%s with no body", (route, fn) => {
  it("passes an object payload, never null", async () => {
    const res = await sdk._fns.get(route)!({
      headers: { authorization: `Bearer ${SECRET}` },
      body: null,
    });
    expect(res.status_code).toBe(200);
    expect(received.get(fn)).not.toBeNull();
    expect(typeof received.get(fn)).toBe("object");
  });
});

describe("api::consolidate field whitelist", () => {
  it("forwards only project and minObservations", async () => {
    await sdk._fns.get("api::consolidate")!({
      headers: { authorization: `Bearer ${SECRET}` },
      body: { project: "/p", minObservations: 3, extra: "dropped" },
    });
    expect(received.get("mem::consolidate")).toEqual({ project: "/p", minObservations: 3 });
  });
});
