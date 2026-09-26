import { describe, it, expect, afterEach } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";

// A fallback is built from a bare ProviderConfig with no baseURL, so the
// provider must resolve ANTHROPIC_BASE_URL itself, as OpenAIProvider does
// with OPENAI_BASE_URL (#1338).
describe("AnthropicProvider base URL (#1338)", () => {
  const saved = process.env["ANTHROPIC_BASE_URL"];

  afterEach(() => {
    if (saved === undefined) delete process.env["ANTHROPIC_BASE_URL"];
    else process.env["ANTHROPIC_BASE_URL"] = saved;
  });

  function baseURLOf(p: AnthropicProvider): string {
    return (p as unknown as { client: { baseURL: string } }).client.baseURL;
  }

  it("falls back to ANTHROPIC_BASE_URL when no baseURL is passed", () => {
    process.env["ANTHROPIC_BASE_URL"] = "https://proxy.example/anthropic";
    expect(baseURLOf(new AnthropicProvider("k", "m", 1024))).toBe("https://proxy.example/anthropic");
  });

  it("prefers an explicit baseURL over the env", () => {
    process.env["ANTHROPIC_BASE_URL"] = "https://proxy.example/anthropic";
    expect(baseURLOf(new AnthropicProvider("k", "m", 1024, "https://explicit.example"))).toBe(
      "https://explicit.example",
    );
  });
});
