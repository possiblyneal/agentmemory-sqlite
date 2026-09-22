import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";
import { ResilientProvider } from "../src/providers/resilient.js";
import type { MemoryProvider } from "../src/types.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenAIProvider.countTokens", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the configured model and text to the broker's tokenize route and returns the token count", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { tokens: [1, 2, 3, 4, 5] }));
    const provider = new OpenAIProvider("key", "general", 4096, "http://broker:4010/v1");

    const count = await provider.countTokens("hello world");

    expect(count).toBe(5);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://broker:4010/tokenize");
    expect(JSON.parse(init.body as string)).toEqual({ model: "general", content: "hello world" });
  });

  it("throws on a non-2xx answer so the caller falls back to the estimate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(404, { error: "no such route" }));
    const provider = new OpenAIProvider("key", "gpt-4o", 4096, "https://api.openai.com");

    await expect(provider.countTokens("hello")).rejects.toThrow(/404/);
  });
});

describe("ResilientProvider.countTokens", () => {
  it("forwards the inner count without touching the circuit breaker", async () => {
    const inner: MemoryProvider = {
      name: "inner",
      compress: async () => "",
      summarize: async () => "",
      countTokens: async () => {
        throw new Error("tokenize down");
      },
    };
    const resilient = new ResilientProvider(inner);

    await expect(resilient.countTokens!("x")).rejects.toThrow("tokenize down");
    await expect(resilient.countTokens!("x")).rejects.toThrow("tokenize down");
    await expect(resilient.countTokens!("x")).rejects.toThrow("tokenize down");
    expect(resilient.circuitState).toMatchObject({ state: "closed", failures: 0 });
  });

  it("is absent when the inner provider cannot count", () => {
    const inner: MemoryProvider = {
      name: "inner",
      compress: async () => "",
      summarize: async () => "",
    };
    expect(new ResilientProvider(inner).countTokens).toBeUndefined();
  });
});
