import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createInprocSdk, type InprocSdk } from "../src/engine/inproc/sdk.js";
import { startViewerServer } from "../src/viewer/server.js";

type Reply = { status: number; body: string };

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const JSON_CT = { "Content-Type": "application/json" };

function registerRoutes(sdk: InprocSdk, onEvict: () => void): void {
  sdk.registerFunction("api::evict", async () => {
    onEvict();
    return { status_code: 200, body: { evicted: true } };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::evict",
    config: { api_path: "/agentmemory/evict", http_method: "POST" },
  } as never);
  sdk.registerFunction("api::ping", async () => ({ status_code: 200, body: { ok: true } }));
  sdk.registerTrigger({
    type: "http",
    function_id: "api::ping",
    config: { api_path: "/agentmemory/ping", http_method: "GET" },
  } as never);
}

describe("request guard on REST and the viewer proxy", () => {
  let dir: string;
  let sdk: InprocSdk;
  let restPort: number;
  let viewer: Server;
  let viewerPort: number;
  let evictCalls: number;
  const savedHosts = process.env.VIEWER_ALLOWED_HOSTS;

  beforeEach(async () => {
    delete process.env.VIEWER_ALLOWED_HOSTS;
    delete process.env.AGENTMEMORY_VIEWER_HOST;
    dir = mkdtempSync(join(tmpdir(), "am-guard-"));
    sdk = createInprocSdk({ restPort: 0, streamsPort: 0, sqlitePath: join(dir, "s.sqlite") });
    await sdk.listening();
    sdk.setReady();
    evictCalls = 0;
    registerRoutes(sdk, () => evictCalls++);
    restPort = sdk.ports().rest;
    viewer = startViewerServer(0, {}, {}, undefined, restPort);
    await new Promise<void>((r) => viewer.once("listening", () => r()));
    viewerPort = (viewer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise((r) => viewer.close(r));
    await sdk.shutdown();
    rmSync(dir, { recursive: true, force: true });
    if (savedHosts === undefined) delete process.env.VIEWER_ALLOWED_HOSTS;
    else process.env.VIEWER_ALLOWED_HOSTS = savedHosts;
  });

  describe.each([
    ["REST", () => restPort],
    ["viewer proxy", () => viewerPort],
  ])("%s", (_name, port) => {
    it("rejects a cross-site JSON POST and never runs the handler", async () => {
      const res = await send(
        port(),
        "POST",
        "/agentmemory/evict",
        { ...JSON_CT, Origin: "https://evil.example" },
        "{}",
      );
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error).toMatch(/origin/i);
      expect(evictCalls).toBe(0);
    });

    it("rejects the opaque Origin null", async () => {
      const res = await send(port(), "POST", "/agentmemory/evict", { ...JSON_CT, Origin: "null" }, "{}");
      expect(res.status).toBe(403);
      expect(evictCalls).toBe(0);
    });

    it("rejects a text/plain POST with no Origin", async () => {
      const res = await send(
        port(),
        "POST",
        "/agentmemory/evict",
        { "Content-Type": "text/plain" },
        "{}",
      );
      expect([403, 415]).toContain(res.status);
      expect(evictCalls).toBe(0);
    });

    it("accepts a JSON POST with no Origin", async () => {
      const res = await send(port(), "POST", "/agentmemory/evict", JSON_CT, "{}");
      expect(res.status).toBe(200);
      expect(evictCalls).toBe(1);
    });

    it("accepts a JSON POST from a loopback Origin on any port", async () => {
      const res = await send(
        port(),
        "POST",
        "/agentmemory/evict",
        { ...JSON_CT, Origin: "http://localhost:5173" },
        "{}",
      );
      expect(res.status).toBe(200);
    });

    it("accepts a JSON POST with a charset parameter", async () => {
      const res = await send(
        port(),
        "POST",
        "/agentmemory/evict",
        { "Content-Type": "application/json; charset=utf-8" },
        "{}",
      );
      expect(res.status).toBe(200);
    });

    it("accepts a cross-origin GET read from the loopback viewer", async () => {
      const res = await send(port(), "GET", "/agentmemory/ping", { Origin: "http://localhost:3113" });
      expect(res.status).toBe(200);
    });

    it("accepts an Origin whose host is in VIEWER_ALLOWED_HOSTS", async () => {
      process.env.VIEWER_ALLOWED_HOSTS = "agentmemory.lan";
      const res = await send(
        port(),
        "POST",
        "/agentmemory/evict",
        { ...JSON_CT, Origin: "http://agentmemory.lan:3113" },
        "{}",
      );
      expect(res.status).toBe(200);
    });
  });

  describe("REST Host allowlist", () => {
    it("rejects an attacker Host", async () => {
      const res = await send(restPort, "GET", "/agentmemory/ping", { Host: "attacker.example" });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error).toMatch(/host/i);
    });

    it.each(["localhost", "localhost:3111", "127.0.0.1:9", "[::1]", "[::1]:3111"])(
      "accepts Host %s",
      async (host) => {
        const res = await send(restPort, "GET", "/agentmemory/ping", { Host: host });
        expect(res.status).toBe(200);
      },
    );

    it("accepts every VIEWER_ALLOWED_HOSTS entry", async () => {
      process.env.VIEWER_ALLOWED_HOSTS = "agentmemory.lan, other.lan:3113";
      for (const host of ["agentmemory.lan", "agentmemory.lan:3111", "other.lan:3113"]) {
        const res = await send(restPort, "GET", "/agentmemory/ping", { Host: host });
        expect(res.status, host).toBe(200);
      }
      const bad = await send(restPort, "GET", "/agentmemory/ping", { Host: "other.lan:9999" });
      expect(bad.status).toBe(403);
    });

    it("accepts the configured bind host", async () => {
      await sdk.shutdown();
      sdk = createInprocSdk({
        restPort: 0,
        streamsPort: 0,
        sqlitePath: join(dir, "b.sqlite"),
        host: "0.0.0.0",
      });
      await sdk.listening();
      sdk.setReady();
      registerRoutes(sdk, () => undefined);
      const res = await send(sdk.ports().rest, "GET", "/agentmemory/ping", { Host: "0.0.0.0:3111" });
      expect(res.status).toBe(200);
    });
  });
});
