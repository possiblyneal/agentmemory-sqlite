import { describe, it, expect, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AnthropicProvider } from "../src/providers/anthropic.js";

const reply = { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 5 } };

describe("AnthropicProvider outbound deadline (#313)", () => {
  const savedTimeout = process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
  let server: Server | undefined;

  afterEach(async () => {
    if (savedTimeout === undefined) delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
    else process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = savedTimeout;
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
    server = undefined;
  });

  async function stub(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    onHit?: () => void,
  ): Promise<string> {
    server = createServer((req, res) => {
      onHit?.();
      req.resume();
      handler(req, res);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("rejects at AGENTMEMORY_LLM_TIMEOUT_MS when the server stalls, without SDK retries", async () => {
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "400";
    let hits = 0;
    const url = await stub(() => {}, () => hits++);
    const provider = new AnthropicProvider("k", "m", 64, url);
    const started = Date.now();
    await expect(provider.summarize("sys", "user")).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hits).toBe(1);
  });

  it("retries a 429 through fetchWithTimeout and succeeds", async () => {
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "10000";
    let hits = 0;
    const url = await stub((_req, res) => {
      res.writeHead(hits === 1 ? 429 : 200, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify(hits === 1 ? { type: "error", error: { type: "rate_limit_error", message: "slow" } } : reply));
    }, () => hits++);
    const provider = new AnthropicProvider("k", "m", 64, url);
    expect(await provider.summarize("sys", "user")).toBe("ok");
    expect(hits).toBe(2);
  });

  it("returns text and tallies usage on a normal reply", async () => {
    const url = await stub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
    const provider = new AnthropicProvider("k", "m", 64, url);
    expect(await provider.summarize("sys", "user")).toBe("ok");
    expect(provider.usage()[0]).toMatchObject({ promptTokens: 3, completionTokens: 5 });
  });
});
