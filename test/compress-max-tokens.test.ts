import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { MinimaxProvider } from "../src/providers/minimax.js";
import { OpenRouterProvider } from "../src/providers/openrouter.js";
import type { MemoryProvider } from "../src/types.js";

let server: Server;
let baseUrl: string;
let sentMaxTokens: number[];

beforeEach(async () => {
  sentMaxTokens = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      sentMaxTokens.push(JSON.parse(body).max_tokens);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "m",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          choices: [{ message: { content: "ok" } }],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise((r) => server.close(r));
});

const providers: Array<[string, (maxTokens: number) => MemoryProvider]> = [
  ["anthropic", (maxTokens) => new AnthropicProvider("k", "m", maxTokens, baseUrl)],
  [
    "minimax",
    (maxTokens) => {
      vi.stubEnv("MINIMAX_BASE_URL", baseUrl);
      return new MinimaxProvider("k", "m", maxTokens);
    },
  ],
  ["openrouter", (maxTokens) => new OpenRouterProvider("k", "m", maxTokens, baseUrl)],
];

describe.each(providers)("%s compress maxTokens", (_name, make) => {
  it("lowers the output budget to a compress call's maxTokens", async () => {
    await make(8192).compress("s", "u", { maxTokens: 2048 });
    expect(sentMaxTokens).toEqual([2048]);
  });

  it("never raises the output budget above MAX_TOKENS", async () => {
    await make(1024).compress("s", "u", { maxTokens: 2048 });
    expect(sentMaxTokens).toEqual([1024]);
  });
});
