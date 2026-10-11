import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import * as vm from "node:vm";
import WebSocket from "ws";

import { createInprocSdk, type InprocSdk } from "../src/engine/inproc/sdk.js";
import { startViewerServer, getBoundViewerPort } from "../src/viewer/server.js";
import { renderViewerDocument } from "../src/viewer/document.js";

const SECRET = "live-secret";

type Outcome = { opened: WebSocket } | { status: number };

function connect(
  url: string,
  headers: Record<string, string> = {},
  protocols?: string[],
): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, { headers });
    ws.once("open", () => resolve({ opened: ws }));
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    ws.once("error", () => {});
  });
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) =>
    ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))),
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe("streams port guard", () => {
  let dir: string;
  let sdk: InprocSdk;
  let url: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "live-stream-"));
    sdk = createInprocSdk({
      restPort: 0,
      streamsPort: 0,
      sqlitePath: join(dir, "s.sqlite"),
      secret: SECRET,
    });
    await sdk.listening();
    url = `ws://127.0.0.1:${sdk.ports().streams}/stream/mem-live/viewer`;
  });

  afterEach(async () => {
    await sdk.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a connection without the secret", async () => {
    expect(await connect(url)).toEqual({ status: 401 });
  });

  it("refuses a disallowed browser Origin even with the secret", async () => {
    const out = await connect(url, {
      authorization: `Bearer ${SECRET}`,
      origin: "https://evil.example",
    });
    expect(out).toEqual({ status: 403 });
  });

  it("delivers events to a client holding the secret", async () => {
    const out = await connect(url, { authorization: `Bearer ${SECRET}` });
    if (!("opened" in out)) throw new Error("expected open");
    const got = nextMessage(out.opened);
    await sdk.trigger({
      function_id: "stream::send",
      payload: { stream_name: "mem-live", group_id: "viewer", type: "t", data: { a: 1 } },
    });
    expect((await got).event.event.data).toEqual({ a: 1 });
    out.opened.close();
  });
});

describe("viewer live proxy", () => {
  let dir: string;
  let sdk: InprocSdk;
  let viewer: ReturnType<typeof startViewerServer>;

  async function boot(port: number) {
    dir = mkdtempSync(join(tmpdir(), "live-stream-"));
    sdk = createInprocSdk({
      restPort: 0,
      streamsPort: 0,
      sqlitePath: join(dir, "s.sqlite"),
      secret: SECRET,
    });
    await sdk.listening();
    viewer = startViewerServer(port, null, null, SECRET, sdk.ports().rest, sdk.ports().streams);
    await vi.waitFor(() => expect(getBoundViewerPort()).toBe(port));
    return `ws://127.0.0.1:${port}/agentmemory/live`;
  }

  afterEach(async () => {
    viewer?.close();
    await sdk?.shutdown();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("relays live events from an allowed Origin, attaching the secret upstream", async () => {
    const url = await boot(await freePort());
    const out = await connect(url, { origin: "http://localhost:3113" });
    if (!("opened" in out)) throw new Error(`expected open, got ${JSON.stringify(out)}`);
    const got = nextMessage(out.opened);
    let received: any;
    void got.then((m) => (received = m));
    await vi.waitFor(async () => {
      await sdk.trigger({
        function_id: "stream::send",
        payload: { stream_name: "mem-live", group_id: "viewer", type: "t", data: { n: 7 } },
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toBeDefined();
    });
    expect(received.event.event.data).toEqual({ n: 7 });
    out.opened.close();
  });

  it("refuses a disallowed Origin", async () => {
    const url = await boot(await freePort());
    expect(await connect(url, { origin: "https://evil.example" })).toEqual({ status: 403 });
  });

  it("requires the viewer bearer on a non-loopback bind, carried as a subprotocol", async () => {
    const port = await freePort();
    vi.stubEnv("AGENTMEMORY_VIEWER_HOST", "0.0.0.0");
    vi.stubEnv("VIEWER_ALLOWED_HOSTS", `127.0.0.1:${port}`);
    const url = await boot(port);
    const origin = { origin: `http://127.0.0.1:${port}` };
    expect(await connect(url, origin)).toEqual({ status: 401 });
    const token = Buffer.from(SECRET).toString("base64url");
    const out = await connect(url, origin, ["agentmemory-bearer", token]);
    expect("opened" in out).toBe(true);
    if ("opened" in out) out.opened.close();
  });
});

describe("viewer page event parsing", () => {
  it("routes an observation nested in a stream::send event", () => {
    const rendered = renderViewerDocument();
    if (!rendered.found) throw new Error("viewer not found");
    const script = rendered.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
    const start = script.indexOf("function looksLikeObservation");
    const end = script.indexOf("function routeWsMessage");
    const routed: any[] = [];
    const sandbox: Record<string, any> = { routeWsMessage: (m: unknown) => routed.push(m) };
    vm.createContext(sandbox);
    vm.runInContext(script.slice(start, end), sandbox);

    const observation = { id: "obs_1", timestamp: "2026-01-01T00:00:00Z", sessionId: "s" };
    sandbox.handleStreamEvent({
      type: "stream",
      streamName: "mem-live",
      groupId: "viewer",
      event: {
        type: "event",
        event: { type: "raw_observation", data: { type: "raw", observation, sessionId: "s" } },
      },
    });
    expect(routed).toEqual([{ observation }]);
  });
});
