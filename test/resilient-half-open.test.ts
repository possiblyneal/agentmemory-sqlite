import { describe, it, expect, vi, afterEach } from "vitest";
import { ResilientProvider } from "../src/providers/resilient.js";
import type { MemoryProvider } from "../src/types.js";

describe("ResilientProvider half-open breaker", () => {
  afterEach(() => vi.useRealTimers());

  it("sends one probe to a provider that is still down, not every queued call", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const inner: MemoryProvider = {
      name: "down",
      compress: async () => {
        calls++;
        throw new Error("connection refused");
      },
      summarize: async () => "",
    };
    const provider = new ResilientProvider(inner);
    for (let i = 0; i < 3; i++) await provider.compress("s", "u").catch(() => {});
    expect(calls).toBe(3);

    vi.advanceTimersByTime(30_000);
    calls = 0;
    await Promise.allSettled(
      Array.from({ length: 8 }, () => provider.compress("s", "u")),
    );
    expect(calls).toBe(1);
  });
  it.each([
    ["busy", Object.assign(new Error("busy"), { status: 429 })],
    ["filtered", new Error("content_filter")],
  ])("releases a %s probe for the next call", async (_name, rejection) => {
    vi.useFakeTimers();
    let mode = "down";
    const inner: MemoryProvider = {
      name: "synthetic",
      compress: async () => {
        if (mode === "down") throw new Error("down");
        if (mode === "reject") throw rejection;
        return "ok";
      },
      summarize: async () => "",
    };
    const provider = new ResilientProvider(inner);
    for (let i = 0; i < 3; i++) await provider.compress("s", "u").catch(() => {});
    vi.advanceTimersByTime(30_000);
    mode = "reject";
    await expect(provider.compress("s", "u")).rejects.toThrow();
    mode = "ok";
    await expect(provider.compress("s", "u")).resolves.toBe("ok");
  });

  it("rejects an open circuit without waiting for a shared slot", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const inner: MemoryProvider = {
      name: "synthetic",
      compress: async () => { throw new Error("down"); },
      summarize: async () => { await pending; return "ok"; },
    };
    const provider = new ResilientProvider(inner);
    for (let i = 0; i < 3; i++) await provider.compress("s", "u").catch(() => {});
    const slots = Array.from({ length: 4 }, () => provider.summarize("s", "u"));
    await Promise.resolve();
    try {
      await expect(provider.compress("s", "u")).rejects.toThrow("circuit_breaker_open");
    } finally {
      release();
      await Promise.all(slots);
    }
  });

});
