import { describe, it, expect } from "vitest";
import { storeAcceptsWrite } from "../src/health/store-probe.js";
import { KV } from "../src/state/schema.js";

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
    list: async () => [],
  };
}

describe("storeAcceptsWrite", () => {
  it("is true when the write reads back", async () => {
    const kv = mockKV();
    expect(await storeAcceptsWrite(kv as never, "_probe")).toBe(true);
    expect(await kv.get(KV.health, "_probe")).not.toBeNull();
  });

  it("is false when the write throws", async () => {
    const kv = { ...mockKV(), set: async () => { throw new Error("SQLITE_READONLY"); } };
    expect(await storeAcceptsWrite(kv as never, "_probe")).toBe(false);
  });

  it("is false when the write does not read back", async () => {
    const kv = { ...mockKV(), set: async <T>(_s: string, _k: string, d: T) => d };
    expect(await storeAcceptsWrite(kv as never, "_probe")).toBe(false);
  });
});
