import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { daemonCall } from "../eval/runner/daemon-http.js";

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("daemonCall", () => {
  it("posts JSON and parses the reply", async () => {
    const base = await serve((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ path: req.url, method: req.method, type: req.headers["content-type"], got: JSON.parse(body) }));
      });
    });
    const { body } = await daemonCall<Record<string, unknown>>(base, "summarize", { body: { sessionId: "s1" } });
    expect(body).toEqual({ path: "/agentmemory/summarize", method: "POST", type: "application/json", got: { sessionId: "s1" } });
  });

  it("throws with the status and body on a non-2xx reply", async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 503;
      res.end("not ready");
    });
    await expect(daemonCall(base, "observations")).rejects.toThrow("observations failed: 503 not ready");
  });

  it("gives up at timeoutMs when no reply comes", async () => {
    const base = await serve(() => {});
    await expect(daemonCall(base, "summarize", { body: {}, timeoutMs: 100 })).rejects.toThrow(/abort|timeout/i);
  });
});
