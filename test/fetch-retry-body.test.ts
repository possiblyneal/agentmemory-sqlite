import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchWithTimeout } from "../src/providers/_fetch.js";

type Reply = { status: number; body?: string; headers?: Record<string, string> };

describe("fetchWithTimeout body retry_after_seconds", () => {
  let server: Server;
  let url: string;
  let replies: Reply[];
  let hits: number[];

  beforeEach(async () => {
    replies = [];
    hits = [];
    server = createServer((_req, res) => {
      hits.push(Date.now());
      const spec = replies[Math.min(hits.length - 1, replies.length - 1)];
      res.writeHead(spec.status, spec.headers);
      res.end(spec.body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("waits the body's retry_after_seconds, not the 500ms backoff, then succeeds", async () => {
    replies = [
      { status: 429, body: JSON.stringify({ retry_after_seconds: 0.8 }) },
      { status: 200, body: "ok" },
    ];
    const res = await fetchWithTimeout(url, {}, 10_000);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(hits[1] - hits[0]).toBeGreaterThanOrEqual(790);
  });

  it("reads retry_after_seconds nested under error", async () => {
    replies = [
      { status: 503, body: JSON.stringify({ error: { retry_after_seconds: 0.8 } }) },
      { status: 200 },
    ];
    const res = await fetchWithTimeout(url, {}, 10_000);
    expect(res.status).toBe(200);
    expect(hits[1] - hits[0]).toBeGreaterThanOrEqual(790);
  });

  it("returns the 429 with a readable body when the wait exceeds the budget", async () => {
    const body = JSON.stringify({ retry_after_seconds: 100000 });
    replies = [{ status: 429, body }, { status: 200 }];
    const res = await fetchWithTimeout(url, {}, 1000);
    expect(res.status).toBe(429);
    expect(hits).toHaveLength(1);
    expect(await res.text()).toBe(body);
  });

  it("lets the Retry-After header win over the body", async () => {
    replies = [
      {
        status: 429,
        headers: { "Retry-After": "0" },
        body: JSON.stringify({ retry_after_seconds: 100000 }),
      },
      { status: 200 },
    ];
    const res = await fetchWithTimeout(url, {}, 2000);
    expect(res.status).toBe(200);
    expect(hits).toHaveLength(2);
  });

  it("falls back to backoff for a non-JSON or negative body", async () => {
    replies = [
      { status: 429, body: "slow down" },
      { status: 429, body: JSON.stringify({ retry_after_seconds: -5 }) },
      { status: 200 },
    ];
    const res = await fetchWithTimeout(url, {}, 10_000);
    expect(res.status).toBe(200);
    expect(hits[1] - hits[0]).toBeGreaterThanOrEqual(490);
    expect(hits[2] - hits[1]).toBeGreaterThanOrEqual(990);
  });
});
