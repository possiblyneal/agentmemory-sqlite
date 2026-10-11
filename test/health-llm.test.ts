import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { ResilientProvider } from "../src/providers/resilient.js";
import { FallbackChainProvider } from "../src/providers/fallback-chain.js";

const SECRET = "llm-health-secret";
const auth = { authorization: `Bearer ${SECRET}` };

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
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

function register(provider: ResilientProvider) {
  const fns = new Map<string, Function>();
  const sdk = {
    registerFunction: (id: string, h: Function) => fns.set(id, h),
    registerTrigger: () => {},
    trigger: async () => undefined,
  };
  const kv = { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] };
  registerApiTriggers(sdk as never, kv as never, SECRET, undefined, provider);
  return fns;
}

describe("/health llm", () => {
  it("shows provider, model, endpoint host and summed token usage after two calls", async () => {
    const provider = new ResilientProvider(new OpenAIProvider("sk-secret", "gpt-test", 10, baseUrl));
    await provider.summarize("s", "u");
    await provider.compress("s", "u");

    const res = await register(provider).get("api::health")!({ headers: auth });

    expect(res.body.llm).toEqual([
      {
        provider: "openai",
        model: "gpt-test",
        endpointHost: new URL(baseUrl).host,
        promptTokens: 20,
        completionTokens: 6,
        totalTokens: 26,
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("sk-secret");
  });

  it("lists every provider of a fallback chain", async () => {
    const chain = new FallbackChainProvider([
      new OpenAIProvider("k", "a", 10, baseUrl),
      new OpenAIProvider("k", "b", 10, baseUrl),
    ]);
    const res = await register(new ResilientProvider(chain)).get("api::health")!({ headers: auth });
    expect(res.body.llm.map((u: { model: string }) => u.model)).toEqual(["a", "b"]);
  });
});
