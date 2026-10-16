import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";

function sentBody(fetchSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string);
}

describe("OpenAIProvider output-token parameter (#1219)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch() {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  it("sends max_completion_tokens to api.openai.com, which rejects max_tokens on reasoning models", async () => {
    const fetchSpy = stubFetch();
    await new OpenAIProvider("key", "gpt-5.6-luna", 4096, "https://api.openai.com").summarize("s", "u");

    const body = sentBody(fetchSpy);
    expect(body.max_completion_tokens).toBe(4096);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("keeps max_tokens for OpenAI-compatible servers", async () => {
    const fetchSpy = stubFetch();
    await new OpenAIProvider("key", "general", 8192, "http://broker:4010/v1").summarize("s", "u");

    const body = sentBody(fetchSpy);
    expect(body.max_tokens).toBe(8192);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("lowers the output budget to a compress call's maxTokens", async () => {
    const fetchSpy = stubFetch();
    await new OpenAIProvider("key", "general", 8192, "http://broker:4010/v1").compress("s", "u", {
      maxTokens: 2048,
    });

    expect(sentBody(fetchSpy).max_tokens).toBe(2048);
  });

  it("never raises the output budget above MAX_TOKENS", async () => {
    const fetchSpy = stubFetch();
    await new OpenAIProvider("key", "general", 1024, "http://broker:4010/v1").compress("s", "u", {
      maxTokens: 2048,
    });

    expect(sentBody(fetchSpy).max_tokens).toBe(1024);
  });
});
