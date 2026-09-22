import { describe, it, expect } from "vitest";
import { ResilientProvider } from "../src/providers/resilient.js";
import type { MemoryProvider } from "../src/types.js";

function fakeProvider(overrides: Partial<MemoryProvider> = {}): MemoryProvider {
  return {
    name: "fake",
    compress: async () => "compressed",
    summarize: async () => "summarized",
    ...overrides,
  };
}

async function failTimes(fn: () => Promise<unknown>, n: number) {
  for (let i = 0; i < n; i++) {
    await expect(fn()).rejects.toThrow();
  }
}

describe("ResilientProvider per-operation breakers", () => {
  it("keeps compress allowed after summarize's breaker opens", async () => {
    const provider = new ResilientProvider(
      fakeProvider({ summarize: async () => { throw new Error("boom"); } }),
    );

    await failTimes(() => provider.summarize("s", "u"), 3);

    expect(provider.circuitStates.summarize.state).toBe("open");
    expect(provider.circuitStates.compress.state).toBe("closed");
    await expect(provider.compress("s", "u")).resolves.toBe("compressed");
    await expect(provider.summarize("s", "u")).rejects.toThrow("circuit_breaker_open");
  });

  it("reports the most severe state as the aggregate, in today's shape", async () => {
    const provider = new ResilientProvider(
      fakeProvider({ compress: async () => { throw new Error("boom"); } }),
    );
    expect(provider.circuitState).toEqual({
      state: "closed",
      failures: 0,
      lastFailureAt: null,
      openedAt: null,
    });

    await failTimes(() => provider.compress("s", "u"), 3);

    const aggregate = provider.circuitState;
    expect(aggregate.state).toBe("open");
    expect(aggregate.failures).toBe(3);
    expect(Object.keys(aggregate).sort()).toEqual(
      ["failures", "lastFailureAt", "openedAt", "state"],
    );
  });

  it("exposes one state per operation", () => {
    const provider = new ResilientProvider(fakeProvider());
    expect(Object.keys(provider.circuitStates).sort()).toEqual(
      ["compress", "describeImage", "summarize"],
    );
    for (const s of Object.values(provider.circuitStates)) {
      expect(s.state).toBe("closed");
    }
  });

  it("forwards describeImage through its own breaker only when the inner provider has one", async () => {
    const plain = new ResilientProvider(fakeProvider());
    expect(plain.describeImage).toBeUndefined();

    const vision = new ResilientProvider(
      fakeProvider({ describeImage: async () => { throw new Error("boom"); } }),
    );
    await failTimes(() => vision.describeImage!("img", "image/png", "p"), 3);

    expect(vision.circuitStates.describeImage.state).toBe("open");
    expect(vision.circuitStates.compress.state).toBe("closed");
    await expect(vision.compress("s", "u")).resolves.toBe("compressed");
  });
});
