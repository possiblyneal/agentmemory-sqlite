import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AnthropicProvider } from "../src/providers/anthropic.js";

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 8, output_tokens: 4 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
});

describe("AnthropicProvider usage", () => {
  it("sums input and output tokens across calls", async () => {
    const provider = new AnthropicProvider("sk-secret", "claude-test", 10, baseUrl);
    await provider.summarize("s", "u");
    await provider.compress("s", "u");
    expect(provider.usage()).toEqual([
      {
        provider: "anthropic",
        model: "claude-test",
        endpointHost: new URL(baseUrl).host,
        promptTokens: 16,
        completionTokens: 8,
        totalTokens: 24,
      },
    ]);
  });
});
