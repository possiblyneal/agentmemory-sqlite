import { describe, it, expect, vi } from "vitest";
import { FallbackChainProvider } from "../src/providers/fallback-chain.js";
import type { MemoryProvider } from "../src/types.js";

function makeProvider(
  name: string,
  impl?: Partial<MemoryProvider>,
): MemoryProvider {
  return {
    name,
    compress: impl?.compress ?? (async () => `compressed by ${name}`),
    summarize: impl?.summarize ?? (async () => `summarized by ${name}`),
    ...(impl?.describeImage ? { describeImage: impl.describeImage } : {}),
  };
}

describe("FallbackChainProvider", () => {
  it("returns result from first provider when it succeeds", async () => {
    const chain = new FallbackChainProvider([
      makeProvider("primary"),
      makeProvider("secondary"),
    ]);
    const result = await chain.compress("sys", "user");
    expect(result).toBe("compressed by primary");
  });

  it("falls back to second provider when first fails", async () => {
    const failing: MemoryProvider = {
      name: "failing",
      compress: async () => {
        throw new Error("primary down");
      },
      summarize: async () => {
        throw new Error("primary down");
      },
    };
    const chain = new FallbackChainProvider([
      failing,
      makeProvider("backup"),
    ]);
    const result = await chain.compress("sys", "user");
    expect(result).toBe("compressed by backup");
  });

  it("throws the last error when all providers fail", async () => {
    const failing1: MemoryProvider = {
      name: "fail1",
      compress: async () => {
        throw new Error("fail1 error");
      },
      summarize: async () => {
        throw new Error("fail1 error");
      },
    };
    const failing2: MemoryProvider = {
      name: "fail2",
      compress: async () => {
        throw new Error("fail2 error");
      },
      summarize: async () => {
        throw new Error("fail2 error");
      },
    };
    const chain = new FallbackChainProvider([failing1, failing2]);
    await expect(chain.compress("sys", "user")).rejects.toThrow("fail2 error");
  });

  it("formats the name correctly", () => {
    const chain = new FallbackChainProvider([
      makeProvider("anthropic"),
      makeProvider("gemini"),
      makeProvider("openrouter"),
    ]);
    expect(chain.name).toBe("fallback(anthropic -> gemini -> openrouter)");
  });

  it("summarize also uses fallback chain", async () => {
    const failing: MemoryProvider = {
      name: "failing",
      compress: async () => {
        throw new Error("down");
      },
      summarize: async () => {
        throw new Error("down");
      },
    };
    const chain = new FallbackChainProvider([
      failing,
      makeProvider("backup"),
    ]);
    const result = await chain.summarize("sys", "user");
    expect(result).toBe("summarized by backup");
  });

  it("passes compress options to the provider that answers", async () => {
    const compress = vi.fn(async () => "ok");
    await new FallbackChainProvider([makeProvider("only", { compress })]).compress("s", "u", {
      maxTokens: 2048,
    });
    expect(compress).toHaveBeenCalledWith("s", "u", { maxTokens: 2048 });
  });

  it("describes an image through the first capable provider that succeeds", async () => {
    const down = vi.fn().mockRejectedValue(new Error("vision down"));
    const up = vi.fn().mockResolvedValue("a diagram");
    const chain = new FallbackChainProvider([
      makeProvider("text-only"),
      makeProvider("vision-a", { describeImage: down }),
      makeProvider("vision-b", { describeImage: up }),
    ]);
    expect(await chain.describeImage?.("b64", "image/png", "describe")).toBe("a diagram");
    expect(down).toHaveBeenCalledWith("b64", "image/png", "describe");
  });

  it("offers no image description when no provider in the chain can", () => {
    const chain = new FallbackChainProvider([makeProvider("a"), makeProvider("b")]);
    expect(chain.describeImage).toBeUndefined();
  });
});
