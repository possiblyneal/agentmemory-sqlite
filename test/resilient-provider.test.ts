import { describe, it, expect, afterEach } from "vitest";
import { ResilientProvider } from "../src/providers/resilient.js";
import type { MemoryProvider } from "../src/types.js";
import { ProviderHttpError } from "../src/providers/_fetch.js";

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

  it("does not open the breaker when the provider only says it is busy", async () => {
    const provider = new ResilientProvider(
      fakeProvider({
        summarize: async () => {
          throw new ProviderHttpError("OpenAI API error (429): queue_full", 429);
        },
      }),
    );

    await failTimes(() => provider.summarize("s", "u"), 5);

    expect(provider.circuitStates.summarize.state).toBe("closed");
  });

  it("treats an SDK error carrying status 503 as busy", async () => {
    const provider = new ResilientProvider(
      fakeProvider({
        compress: async () => {
          throw Object.assign(new Error("overloaded"), { status: 503 });
        },
      }),
    );

    await failTimes(() => provider.compress("s", "u"), 5);

    expect(provider.circuitStates.compress.state).toBe("closed");
  });
});

describe("ResilientProvider concurrency cap", () => {
  afterEach(() => {
    delete process.env.AGENTMEMORY_LLM_MAX_CONCURRENCY;
  });

  it("holds calls past AGENTMEMORY_LLM_MAX_CONCURRENCY until a slot frees, across operations", async () => {
    process.env.AGENTMEMORY_LLM_MAX_CONCURRENCY = "1";
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const gated = () =>
      new Promise<string>((resolve) => {
        running++;
        peak = Math.max(peak, running);
        releases.push(() => {
          running--;
          resolve("ok");
        });
      });
    const provider = new ResilientProvider(
      fakeProvider({ compress: gated, summarize: gated }),
    );

    const first = provider.compress("s", "u");
    const second = provider.summarize("s", "u");
    await new Promise((r) => setTimeout(r, 0));
    expect(releases).toHaveLength(1);

    releases[0]();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(releases).toHaveLength(2);
    releases[1]();
    await second;

    expect(peak).toBe(1);
  });

  it("frees the slot when a call throws", async () => {
    process.env.AGENTMEMORY_LLM_MAX_CONCURRENCY = "1";
    const provider = new ResilientProvider(
      fakeProvider({ summarize: async () => { throw new Error("boom"); } }),
    );

    await expect(provider.summarize("s", "u")).rejects.toThrow("boom");
    await expect(provider.compress("s", "u")).resolves.toBe("compressed");
  });
});
