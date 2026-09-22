import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer, request as httpRequest, type Server } from "node:http";
import { resolveProxyPath, startViewerServer } from "../src/viewer/server.js";

const SECRET = "viewer-proxy-test-secret";

describe("resolveProxyPath", () => {
  it("accepts a plain path inside the prefix", () => {
    expect(resolveProxyPath("/agentmemory/health")).toBe("/agentmemory/health");
    expect(resolveProxyPath("/agentmemory/session/ses_1")).toBe("/agentmemory/session/ses_1");
  });

  it("rejects paths that escape or never enter the prefix", () => {
    expect(resolveProxyPath("/other")).toBeNull();
    expect(resolveProxyPath("/agentmemory")).toBeNull();
    expect(resolveProxyPath("/agentmemory/../other")).toBeNull();
    expect(resolveProxyPath("/agentmemory/%2e%2e/other")).toBeNull();
    expect(resolveProxyPath("/agentmemory%2F..%2Fother")).toBeNull();
    expect(resolveProxyPath("/agentmemory/%2Fhealth")).toBeNull();
    expect(resolveProxyPath("/agentmemory//health")).toBeNull();
    expect(resolveProxyPath("/agentmemory/%E0%A4%A")).toBeNull();
  });
});

describe("viewer proxy forwards only /agentmemory/ paths (e2e)", () => {
  const seen: Array<{ path: string; authorization: string | undefined }> = [];
  let upstream: Server;
  let viewer: Server;
  let viewerPort: number;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen.push({ path: req.url ?? "", authorization: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    viewer = startViewerServer(0, {}, {}, SECRET, upstreamPort);
    await new Promise<void>((resolve) => viewer.once("listening", resolve));
    viewerPort = (viewer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => viewer.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  function get(path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: viewerPort, path, method: "GET" },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("answers 404 locally for paths outside the prefix and never forwards them", async () => {
    for (const path of ["/agentmemory/../other", "/agentmemory/%2e%2e/other", "/other"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it("forwards a legitimate path with the bearer attached", async () => {
    const res = await get("/agentmemory/health");
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(seen).toEqual([
      { path: "/agentmemory/health", authorization: `Bearer ${SECRET}` },
    ]);
  });

  it("never lets the bearer leave on a request outside the prefix", () => {
    for (const r of seen) {
      if (r.authorization) expect(r.path.startsWith("/agentmemory/")).toBe(true);
    }
  });
});
