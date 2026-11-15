import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const loadedUndici = () =>
  Object.keys(createRequire(import.meta.url).cache).filter((p) =>
    /[\\/]node_modules[\\/]undici[\\/]/.test(p),
  );

describe("fetchWithTimeout's undici dispatcher", () => {
  it("is not loaded by importing the module, only by the first request", async () => {
    const { fetchWithTimeout } = await import("../src/providers/_fetch.js");
    expect(loadedUndici()).toEqual([]);

    await fetchWithTimeout("http://127.0.0.1:1/", {}, 1000).catch(() => {});
    expect(loadedUndici().length).toBeGreaterThan(0);
  });
});
