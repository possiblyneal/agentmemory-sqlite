import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAIProvider } from "../src/providers/openai.js";

let server: Server;
let baseUrl: string;
let reply: unknown;
let received: Record<string, unknown>;

beforeEach(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received = JSON.parse(raw);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise((r) => server.close(r));
});

describe("OpenAIProvider reply handling", () => {
  it("throws when a reasoning model is cut off at max_tokens with no content", async () => {
    reply = { choices: [{ finish_reason: "length", message: { content: "", reasoning: "half a thought" } }] };
    await expect(new OpenAIProvider("k", "m", 10, baseUrl).summarize("s", "u")).rejects.toThrow(/length/);
  });

  it("still returns reasoning when the model stopped normally", async () => {
    reply = { choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: "the answer" } }] };
    await expect(new OpenAIProvider("k", "m", 10, baseUrl).summarize("s", "u")).resolves.toBe("the answer");
  });
});

describe("OpenAIProvider usage", () => {
  it("sums reported tokens across calls and names model and endpoint host only", async () => {
    const provider = new OpenAIProvider("sk-secret", "m", 10, `${baseUrl}/v1?key=hidden`);
    reply = {
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    };
    await provider.summarize("s", "u");
    reply = {
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    await provider.compress("s", "u");
    expect(provider.usage()).toEqual([
      {
        provider: "openai",
        model: "m",
        endpointHost: new URL(baseUrl).host,
        promptTokens: 15,
        completionTokens: 5,
        totalTokens: 20,
      },
    ]);
    expect(JSON.stringify(provider.usage())).not.toContain("sk-secret");
  });
});

describe("OPENAI_EXTRA_BODY", () => {
  it("is merged into the request body", async () => {
    vi.stubEnv("OPENAI_EXTRA_BODY", '{"chat_template_kwargs":{"enable_thinking":false}}');
    reply = { choices: [{ finish_reason: "stop", message: { content: "ok" } }] };
    await new OpenAIProvider("k", "m", 10, baseUrl).summarize("s", "u");
    expect(received.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(received.model).toBe("m");
  });

  it("fails at construction with the variable named when not a JSON object", () => {
    vi.stubEnv("OPENAI_EXTRA_BODY", "{nope");
    expect(() => new OpenAIProvider("k", "m", 10, baseUrl)).toThrow(/OPENAI_EXTRA_BODY/);
    vi.stubEnv("OPENAI_EXTRA_BODY", "[1]");
    expect(() => new OpenAIProvider("k", "m", 10, baseUrl)).toThrow(/OPENAI_EXTRA_BODY/);
  });
});

describe("OpenAIProvider streamed reply (#329)", () => {
  let sse: Server;
  let sseUrl: string;
  let chunks: Array<{ after: number; data: string }>;

  const event = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }], ...extra })}\n\n`;

  beforeEach(async () => {
    sse = createServer((req, res) => {
      req.resume();
      req.on("end", async () => {
        res.setHeader("Content-Type", "text/event-stream");
        res.flushHeaders();
        for (const { after, data } of chunks) {
          await new Promise((r) => setTimeout(r, after));
          if (res.destroyed) return;
          res.write(data);
        }
        res.end();
      });
    });
    await new Promise<void>((r) => sse.listen(0, "127.0.0.1", r));
    sseUrl = `http://127.0.0.1:${(sse.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    sse.closeAllConnections();
    await new Promise((r) => sse.close(r));
  });

  it("asks for a stream", async () => {
    await new OpenAIProvider("k", "m", 10, baseUrl).summarize("s", "u").catch(() => {});
    expect(received.stream).toBe(true);
  });

  it("finishes a reply that writes for longer than the timeout in total", async () => {
    vi.stubEnv("OPENAI_TIMEOUT_MS", "150");
    chunks = [
      ...["a", "b", "c", "d", "e"].map((c) => ({ after: 60, data: event({ content: c }) })),
      {
        after: 0,
        data:
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 5 } })}\n\n` +
          "data: [DONE]\n\n",
      },
    ];
    const provider = new OpenAIProvider("k", "m", 10, sseUrl);
    await expect(provider.summarize("s", "u")).resolves.toBe("abcde");
    expect(provider.usage()[0]).toMatchObject({ promptTokens: 4, completionTokens: 5 });
  });

  it("times out a reply that falls silent, naming how far it got", async () => {
    vi.stubEnv("OPENAI_TIMEOUT_MS", "100");
    chunks = [
      { after: 0, data: event({ content: "half" }) },
      { after: 400, data: event({ content: " more" }) },
    ];
    await expect(new OpenAIProvider("k", "m", 10, sseUrl).summarize("s", "u")).rejects.toThrow(
      /received nothing for 100ms after 4 reply chars/,
    );
  });

  it("keeps the max_tokens guard for a streamed reasoning reply", async () => {
    chunks = [
      { after: 0, data: event({ reasoning_content: "half a thought" }) },
      { after: 0, data: `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n` },
    ];
    await expect(new OpenAIProvider("k", "m", 10, sseUrl).summarize("s", "u")).rejects.toThrow(/length/);
  });
});
