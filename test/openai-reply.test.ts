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
