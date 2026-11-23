import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { handleToolCall, handleToolsList, handleResourcesList, handleResourcesRead, handlePromptsList, handlePromptsGet, hydrateMcpEnv } from "../src/mcp/standalone.js";
import { resetHandleForTests } from "../src/mcp/rest-proxy.js";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";

type FetchMock = ReturnType<typeof vi.fn>;

function installFetch(handler: (url: string, init?: RequestInit) => Response): FetchMock {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(url.toString(), init),
  );
  (globalThis as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

const BASE = "http://localhost:3111";
process.env["AGENTMEMORY_PROJECT_NAME"] = "cwd-project";

describe("@agentmemory/mcp standalone — server proxy (issue #159)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetHandleForTests();
    delete process.env["AGENTMEMORY_URL"];
    delete process.env["AGENTMEMORY_SECRET"];
    vi.stubEnv("FALLBACK_PROVIDERS", "");
  });

  afterEach(() => {
    resetHandleForTests();
    globalThis.fetch = originalFetch;
    delete process.env["AGENTMEMORY_URL"];
    vi.unstubAllEnvs();
  });

  it("proxies memory_sessions to GET /agentmemory/sessions when server is up", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    installFetch((url, init) => {
      calls.push({ url, method: init?.method || "GET" });
      if (url.endsWith("/agentmemory/livez")) {
        return new Response("ok", { status: 200 });
      }
      if (url.includes("/agentmemory/sessions")) {
        return new Response(
          JSON.stringify({ sessions: [{ id: "sess-1", observations: 69 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const res = await handleToolCall("memory_sessions", { limit: 5 });
    const body = JSON.parse(res.content[0].text);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe("sess-1");
    expect(calls.find((c) => c.url.includes("/sessions"))).toBeDefined();
  });

  it.each(["bad", "2", null, true, {}, [], 1.5, NaN, Infinity])("rejects malformed smart-search limit %j", async (limit) => {
    await expect(handleToolCall("memory_smart_search", { query: "auth", limit }, new InMemoryKV()))
      .rejects.toThrow("limit must be an integer");
  });

  it.each([[undefined, 10], [-1, 10], [0, 10], [15, 15], [101, 100]])(
    "forwards normalized smart-search limit %s", async (limit, expected) => {
      let received: unknown;
      installFetch((url, init) => {
        if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
        received = JSON.parse(init?.body as string).limit;
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      });
      await handleToolCall("memory_smart_search", { query: "auth", limit });
      expect(received).toBe(expected);
    },
  );

  it("proxies memory_smart_search to POST /agentmemory/smart-search", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/smart-search")) {
        const body = JSON.parse((init?.body as string) || "{}");
        return new Response(
          JSON.stringify({
            mode: "compact",
            query: body.query,
            results: [{ id: "m1", score: 0.9 }],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    const res = await handleToolCall("memory_smart_search", { query: "auth bug", limit: 5 });
    const body = JSON.parse(res.content[0].text);
    expect(body.query).toBe("auth bug");
    expect(body.results[0].id).toBe("m1");
  });

  it("forwards expandIds to smart-search with no query, scoped to the cwd project", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/smart-search")) {
        bodies.push(JSON.parse((init?.body as string) || "{}"));
        return new Response(JSON.stringify({ mode: "expanded", results: [] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    await handleToolCall("memory_smart_search", { expandIds: "mem_a, mem_b" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]["expandIds"]).toEqual(["mem_a", "mem_b"]);
    expect(bodies[0]["project"]).toBe("cwd-project");
    expect(bodies[0]["query"]).toBeUndefined();
  });

  it("gives reflect and consolidate a call timeout past 15 s and keeps 15 s elsewhere", async () => {
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return realTimeout(ms);
    });
    try {
      installFetch((url) => {
        if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
        return new Response(JSON.stringify({ content: [] }), { status: 200 });
      });
      timeouts.length = 0;
      await handleToolCall("memory_reflect", {});
      const reflect = timeouts.at(-1)!;
      await handleToolCall("memory_consolidate", {});
      const consolidate = timeouts.at(-1)!;
      await handleToolCall("memory_sessions", {});
      const sessions = timeouts.at(-1)!;
      expect(reflect).toBe(1_215_000);
      expect(consolidate).toBe(60_000);
      expect(sessions).toBe(15_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("allows for an OpenAI provider timeout longer than the shared timeout", async () => {
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return realTimeout(ms);
    });
    process.env["OPENAI_TIMEOUT_MS"] = "120000";
    try {
      installFetch(() => new Response(JSON.stringify({ content: [] }), { status: 200 }));
      await handleToolCall("memory_reflect", {});
      expect(timeouts.at(-1)).toBe(2_415_000);
    } finally {
      delete process.env["OPENAI_TIMEOUT_MS"];
      spy.mockRestore();
    }
  });

  it.each([
    ["fractional shared timeout below one", "0.5", undefined, undefined, undefined, 1_215_000],
    ["fractional shared timeout accepted by Anthropic", "120000.5", undefined, undefined, undefined, 2_415_000],
    ["shared timeout integer", "20000", undefined, undefined, undefined, 415_000],
    ["fractional OpenAI override", undefined, "60000.01", undefined, undefined, 1_215_000],
    ["opted-in SDK default", undefined, undefined, "true", undefined, 3_615_000],
    ["opted-in SDK override", undefined, undefined, "true", "220000", 4_415_000],
  ])("uses the Reflect budget for %s", async (_label, shared, openai, allowSdk, sdk, expected) => {
    vi.stubEnv("AGENTMEMORY_LLM_TIMEOUT_MS", shared);
    vi.stubEnv("OPENAI_TIMEOUT_MS", openai);
    vi.stubEnv("AGENTMEMORY_ALLOW_AGENT_SDK", allowSdk);
    vi.stubEnv("AGENTMEMORY_AGENT_SDK_TIMEOUT_MS", sdk);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      installFetch(() => Response.json({ content: [] }));
      await expect(handleToolCall("memory_reflect", {})).resolves.toEqual({ content: [] });
      expect(timeout).toHaveBeenLastCalledWith(expected);
    } finally {
      timeout.mockRestore();
    }
  });

  it("uses a deadline-only dispatcher for Reflect and aborts a stalled response", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/agentmemory/livez") res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    process.env["AGENTMEMORY_URL"] = `http://127.0.0.1:${address.port}`;
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      realTimeout(ms > 60_000 ? 200 : ms),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(handleToolCall("memory_reflect", {})).rejects.toThrow(/timeout/i);
      const [probe, reflect] = fetchSpy.mock.calls;
      expect(probe?.[1]).not.toHaveProperty("dispatcher");
      expect(reflect?.[1]).toHaveProperty("dispatcher");
      expect(reflect?.[1]?.signal?.aborted).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      timeout.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("proxies memory_recall to POST /agentmemory/search and forwards format/token_budget (#507)", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/agentmemory/search")) {
        return new Response(
          JSON.stringify({
            mode: "full",
            facts: [{ id: "m1" }],
            narrative: "n",
            concepts: ["c"],
            files: ["f"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const res = await handleToolCall("memory_recall", {
      query: "auth bug",
      limit: 5,
      format: "full",
      token_budget: 800,
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.mode).toBe("full");
    expect(body.facts[0].id).toBe("m1");
    const searchCall = calls.find((c) => c.url.endsWith("/agentmemory/search"));
    expect(searchCall).toBeDefined();
    expect(searchCall?.body).toEqual({
      query: "auth bug",
      limit: 5,
      format: "full",
      token_budget: 800,
      project: "cwd-project",
      targetLayer: "memory",
    });
    expect(calls.find((c) => c.url.endsWith("/agentmemory/smart-search"))).toBeUndefined();
  });

  it("forwards date bounds on Recall and smart search", async () => {
    const bodies = new Map<string, Record<string, unknown>>();
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      bodies.set(new URL(url).pathname, JSON.parse((init?.body as string) || "{}"));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const bounds = { after: "2026-01-01T00:00:00Z", before: "2026-02-01T00:00:00Z" };
    await handleToolCall("memory_recall", { query: "x", ...bounds });
    await handleToolCall("memory_smart_search", { query: "x", ...bounds });
    expect(bodies.get("/agentmemory/search")).toMatchObject(bounds);
    expect(bodies.get("/agentmemory/smart-search")).toMatchObject(bounds);
  });

  it("forwards Session bounds and absolute offset through the proxy", async () => {
    let requested: URL | undefined;
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      requested = new URL(url);
      return new Response(JSON.stringify({ sessions: [], total: 0 }), { status: 200 });
    });
    await handleToolCall("memory_sessions", { after: "2026-01-01T01:00:00+01:00", before: "2026-02-01T00:00:00Z", limit: 2, offset: 3 });
    expect(requested?.searchParams.get("after")).toBe("2026-01-01T01:00:00+01:00");
    expect(requested?.searchParams.get("before")).toBe("2026-02-01T00:00:00Z");
    expect(requested?.searchParams.get("offset")).toBe("3");
    expect(requested?.searchParams.get("limit")).toBe("2");
  });

  it.each(["memory_sessions", "memory_recall", "memory_smart_search"])("rejects invalid bounds before proxy or local fallback for %s", async (name) => {
    for (const bounds of [{ after: "2026-01-01" }, { before: "2026-02-30T00:00:00Z" }, { after: "2026-02-01T00:00:00Z", before: "2026-01-01T00:00:00Z" }]) {
      await expect(handleToolCall(name, { query: "auth", ...bounds })).rejects.toThrow();
    }
  });

  it("forwards project on memory_recall and memory_smart_search (#787)", async () => {
    const bodies = new Map<string, Record<string, unknown>>();
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      bodies.set(new URL(url).pathname, JSON.parse((init?.body as string) || "{}"));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    await handleToolCall("memory_recall", { query: "x", project: "my-project" });
    await handleToolCall("memory_smart_search", { query: "x", project: "my-project" });
    expect(bodies.get("/agentmemory/search")?.["project"]).toBe("my-project");
    expect(bodies.get("/agentmemory/smart-search")?.["project"]).toBe("my-project");
  });

  it("memory_recall defaults format to 'full' when omitted (#507)", async () => {
    let recallBody: Record<string, unknown> | undefined;
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/search")) {
        recallBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify({ mode: "full", facts: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    await handleToolCall("memory_recall", { query: "x" });
    expect(recallBody?.["format"]).toBe("full");
    expect(recallBody).not.toHaveProperty("token_budget");
  });

  it("memory_recall searches Memories by default and forwards an explicit targetLayer (#191)", async () => {
    const layers: unknown[] = [];
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      layers.push(JSON.parse(init?.body as string)["targetLayer"]);
      return new Response(JSON.stringify({ mode: "full", facts: [] }), { status: 200 });
    });
    await handleToolCall("memory_recall", { query: "x" });
    await handleToolCall("memory_recall", { query: "x", targetLayer: "all" });
    await expect(
      handleToolCall("memory_recall", { query: "x", targetLayer: "everything" }),
    ).rejects.toThrow(/targetLayer/);
    expect(layers).toEqual(["memory", "all"]);
  });

  it("proxies memory_governance_delete to the DELETE REST endpoint", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    installFetch((url, init) => {
      const method = init?.method || "GET";
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (url.endsWith("/agentmemory/governance/memories") && method === "DELETE") {
        return new Response(JSON.stringify({ success: true, deleted: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("method not allowed", { status: 405, statusText: "Method Not Allowed" });
    });

    const res = await handleToolCall("memory_governance_delete", {
      memoryIds: "mem_1, mem_2",
      reason: "cleanup stale test data",
    });

    expect(JSON.parse(res.content[0].text)).toEqual({ success: true, deleted: 2 });
    expect(calls).toEqual([
      {
        url: `${BASE}/agentmemory/governance/memories`,
        method: "DELETE",
        body: {
          memoryIds: ["mem_1", "mem_2"],
          reason: "cleanup stale test data",
        },
      },
    ]);
  });

  it("local fallback returns the same shape as proxy for memory_smart_search", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const localKv = new InMemoryKV(undefined);
    await handleToolCall("memory_save", { content: "shape-check entry" }, localKv);
    const res = await handleToolCall("memory_smart_search", { query: "shape" }, localKv);
    const body = JSON.parse(res.content[0].text);
    expect(body).toHaveProperty("mode", "compact");
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results[0].content).toBe("shape-check entry");
  });

  it("local fallback drops memories saved to another project (#787)", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const localKv = new InMemoryKV(undefined);
    await handleToolCall("memory_save", { content: "scoped here", project: "here" }, localKv);
    await handleToolCall("memory_save", { content: "scoped there", project: "there" }, localKv);
    await handleToolCall("memory_save", { content: "scoped nowhere", global: true }, localKv);
    const res = await handleToolCall(
      "memory_smart_search",
      { query: "scoped", project: "here" },
      localKv,
    );
    const contents = JSON.parse(res.content[0].text).results.map(
      (r: { content: string }) => r.content,
    );
    expect(contents.sort()).toEqual(["scoped here", "scoped nowhere"]);
  });

  it("attaches Bearer token on the proxied tool request, not just the probe", async () => {
    process.env["AGENTMEMORY_SECRET"] = "s3cret";
    const authByPath = new Map<string, string | undefined>();
    installFetch((url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.[
        "authorization"
      ];
      const u = new URL(url);
      authByPath.set(u.pathname, auth);
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    });
    await handleToolCall("memory_sessions", {});
    expect(authByPath.get("/agentmemory/livez")).toBe("Bearer s3cret");
    expect(authByPath.get("/agentmemory/sessions")).toBe("Bearer s3cret");
  });

  it("orders numeric and string local Session starts together before bounded paging", async () => {
    installFetch(() => { throw new Error("ECONNREFUSED"); });
    const localKv = new InMemoryKV(undefined);
    await localKv.set("mem:sessions", "older", { id: "older", startedAt: Date.parse("2026-01-05T00:00:00Z") });
    await localKv.set("mem:sessions", "middle", { id: "middle", startedAt: "2026-01-07T00:00:00Z" });
    await localKv.set("mem:sessions", "newer", { id: "newer", startedAt: Date.parse("2026-01-10T00:00:00Z") });
    const result = await handleToolCall("memory_sessions", { after: "2026-01-01T00:00:00Z", limit: 2, offset: 0 }, localKv);
    expect(JSON.parse(result.content[0].text).sessions.map((s: { id: string }) => s.id)).toEqual(["newer", "middle"]);
  });
  it("orders bounded local Sessions by exact instant before paging, without changing unbounded order", async () => {
    installFetch(() => { throw new Error("ECONNREFUSED"); });
    const localKv = new InMemoryKV(undefined);
    await localKv.set("mem:sessions", "old", { id: "old", startedAt: "2026-01-01T01:00:00+01:00" });
    await localKv.set("mem:sessions", "new", { id: "new", startedAt: "2026-01-01T00:00:00.0009Z" });
    await localKv.set("mem:sessions", "middle", { id: "middle", startedAt: "2026-01-01T00:00:00.0002Z" });
    const bounded = await handleToolCall("memory_sessions", { after: "2026-01-01T00:00:00Z", limit: 1, offset: 1 }, localKv);
    const unbounded = await handleToolCall("memory_sessions", { limit: 3 }, localKv);
    expect(JSON.parse(bounded.content[0].text).sessions.map((s: { id: string }) => s.id)).toEqual(["middle"]);
    expect(JSON.parse(unbounded.content[0].text).sessions.map((s: { id: string }) => s.id)).toEqual(["old", "new", "middle"]);
  });

  it("filters local Memories and Sessions before pagination", async () => {
    installFetch(() => { throw new Error("ECONNREFUSED"); });
    const localKv = new InMemoryKV(undefined);
    await localKv.set("mem:memories", "old", { id: "old", content: "local", createdAt: "2026-01-01T00:00:00Z" });
    await localKv.set("mem:memories", "new", { id: "new", content: "local", createdAt: "2026-02-01T00:00:00Z" });
    await localKv.set("mem:sessions", "old", { id: "old", startedAt: "2026-01-01T00:00:00Z" });
    await localKv.set("mem:sessions", "new", { id: "new", startedAt: "2026-02-01T00:00:00Z" });
    await localKv.set("mem:sessions", "middle", { id: "middle", startedAt: "2026-01-15T00:00:00Z" });
    const args = { after: "2026-01-01T00:00:00Z", before: "2026-02-01T00:00:00Z" };
    const recall = await handleToolCall("memory_recall", { query: "local", ...args }, localKv);
    const sessions = await handleToolCall("memory_sessions", { ...args, limit: 1, offset: 1 }, localKv);
    const expanded = await handleToolCall("memory_smart_search", { expandIds: "new", ...args }, localKv);
    expect(JSON.parse(recall.content[0].text).results.map((r: { id: string }) => r.id)).toEqual(["old"]);
    expect(JSON.parse(sessions.content[0].text).sessions.map((r: { id: string }) => r.id)).toEqual(["old"]);
    expect(JSON.parse(expanded.content[0].text).results.map((r: { id: string }) => r.id)).toEqual(["new"]);
  });

  it("falls back to local InMemoryKV when server is unreachable", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const localKv = new InMemoryKV(undefined);
    await handleToolCall("memory_save", { content: "local only" }, localKv);
    const recall = await handleToolCall("memory_recall", { query: "local" }, localKv);
    const out = JSON.parse(recall.content[0].text);
    expect(out.mode).toBe("compact");
    expect(out.results).toHaveLength(1);
    expect(out.results[0].content).toBe("local only");
  });

  it("a 503 from the server is an error, never a local save", async () => {
    let calls = 0;
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      calls++;
      return new Response(JSON.stringify({ error: "starting" }), { status: 503, statusText: "Service Unavailable" });
    });
    const localKv = new InMemoryKV(undefined);
    await expect(handleToolCall("memory_save", { content: "must not land locally" }, localKv)).rejects.toThrow(/not ready \(503\)/);
    expect(calls).toBe(1);
    // Nothing reached the local store.
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    resetHandleForTests();
    const recall = await handleToolCall("memory_recall", { query: "locally" }, localKv);
    expect(JSON.parse(recall.content[0].text).results).toHaveLength(0);
  });

  it("tools/list under a 503 is an error, not the reduced local list", async () => {
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      return new Response(JSON.stringify({ error: "starting" }), { status: 503, statusText: "Service Unavailable" });
    });
    await expect(handleToolsList()).rejects.toThrow(/not ready \(503\)/);
  });

  it("an error the server answers with is surfaced, never a local save (upstream PR #1323)", async () => {
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      return new Response("boom", { status: 500, statusText: "Internal Server Error" });
    });
    const localKv = new InMemoryKV(undefined);
    await expect(handleToolCall("memory_save", { content: "must not land locally" }, localKv)).rejects.toThrow(/500.*boom/);
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    resetHandleForTests();
    const recall = await handleToolCall("memory_recall", { query: "locally" }, localKv);
    expect(JSON.parse(recall.content[0].text).results).toHaveLength(0);
  });

  it("a gateway 502 counts as the daemon being down, so the call falls back to local", async () => {
    let probeCount = 0;
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) {
        probeCount++;
        return new Response("ok", { status: 200 });
      }
      return new Response("upstream down", { status: 502, statusText: "Bad Gateway" });
    });
    const localKv = new InMemoryKV(undefined);
    await handleToolCall("memory_save", { content: "gateway fallback" }, localKv);
    await handleToolCall("memory_save", { content: "second gateway fallback" }, localKv);
    expect(probeCount).toBe(2);
  });

  it("invalidates the handle when the server stops answering, so the next call re-probes", async () => {
    let probeCount = 0;
    let serverUp = true;
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) {
        probeCount++;
        return serverUp ? new Response("ok", { status: 200 }) : new Response("", { status: 500 });
      }
      throw new Error("ECONNRESET");
    });
    const localKv = new InMemoryKV(undefined);
    await handleToolCall("memory_save", { content: "first fallback" }, localKv);
    expect(probeCount).toBe(1);
    serverUp = false;
    await handleToolCall("memory_save", { content: "second fallback" }, localKv);
    expect(probeCount).toBe(2);
  });

  it("forwards non-essential tools to /agentmemory/mcp/call (#234)", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) {
        return new Response("ok", { status: 200 });
      }
      if (url.endsWith("/agentmemory/mcp/call")) {
        const body = init?.body ? JSON.parse(init.body as string) : null;
        calls.push({ url, body });
        return new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({ saved: "lesson_xyz" }),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const res = await handleToolCall("memory_lesson_save", {
      title: "Always pin lockfiles",
      content: "...",
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.saved).toBe("lesson_xyz");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      name: "memory_lesson_save",
      arguments: { title: "Always pin lockfiles", content: "...", project: "cwd-project" },
    });
  });

  it("rejects non-essential tools when no server is reachable (#234)", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const localKv = new InMemoryKV(undefined);
    await expect(
      handleToolCall("memory_lesson_recall", { query: "x" }, localKv),
    ).rejects.toThrow(/Unknown tool: memory_lesson_recall/);
  });

  it("does not retry local after a validation error", async () => {
    const fetchFn = installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const localKv = new InMemoryKV(undefined);
    await expect(
      handleToolCall("memory_save", { content: "" }, localKv),
    ).rejects.toThrow("content is required");
    const remembersCalled = fetchFn.mock.calls.some(([url]) =>
      String(url).endsWith("/agentmemory/remember"),
    );
    expect(remembersCalled).toBe(false);
  });

  it("AGENTMEMORY_FORCE_PROXY=1 skips livez probe and trusts the server", async () => {
    process.env["AGENTMEMORY_FORCE_PROXY"] = "1";
    const calls: string[] = [];
    installFetch((url, init) => {
      calls.push(url);
      if (url.endsWith("/agentmemory/livez")) {
        throw new Error("probe should be skipped");
      }
      if (url.endsWith("/agentmemory/remember")) {
        return new Response(JSON.stringify({ id: "m-1", action: "created" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      await handleToolCall("memory_save", { content: "force-proxy" });
      expect(calls.some((u) => u.endsWith("/agentmemory/livez"))).toBe(false);
      expect(calls.some((u) => u.endsWith("/agentmemory/remember"))).toBe(true);
    } finally {
      delete process.env["AGENTMEMORY_FORCE_PROXY"];
    }
  });

  it("logs probe failure to stderr so sandboxed clients can diagnose silently dropped tools", async () => {
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) {
        throw new Error("ECONNREFUSED 127.0.0.1:3111");
      }
      return new Response("not found", { status: 404 });
    });
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const localKv = new InMemoryKV(undefined);
      await handleToolCall("memory_save", { content: "diag" }, localKv);
    } finally {
      process.stderr.write = origWrite;
    }
    const joined = writes.join("");
    expect(joined).toMatch(/livez probe .* failed/);
    expect(joined).toMatch(/AGENTMEMORY_FORCE_PROXY/);
  });

  it("local fallback tools/list returns all 7 IMPLEMENTED_TOOLS regardless of AGENTMEMORY_TOOLS env (#234)", async () => {
    const { handleToolsList } = await import("../src/mcp/standalone.js");
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    delete process.env["AGENTMEMORY_TOOLS"];
    const before = await handleToolsList();
    const beforeTools = before.tools as Array<{ name: string }>;
    expect(beforeTools.map((t) => t.name).sort()).toEqual([
      "memory_audit",
      "memory_export",
      "memory_governance_delete",
      "memory_recall",
      "memory_save",
      "memory_sessions",
      "memory_smart_search",
    ]);
    expect(beforeTools).toHaveLength(7);

    resetHandleForTests();
    process.env["AGENTMEMORY_TOOLS"] = "core";
    const core = await handleToolsList();
    expect((core.tools as unknown[]).length).toBe(7);
    delete process.env["AGENTMEMORY_TOOLS"];
  });

  it("AGENTMEMORY_PROBE_TIMEOUT_MS overrides the default probe timeout", async () => {
    process.env["AGENTMEMORY_PROBE_TIMEOUT_MS"] = "50";
    let probeStarted = 0;
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) {
        probeStarted++;
        return new Response("ok", { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const localKv = new InMemoryKV(undefined);
      await handleToolCall("memory_save", { content: "timeout-knob" }, localKv);
      expect(probeStarted).toBe(1);
    } finally {
      delete process.env["AGENTMEMORY_PROBE_TIMEOUT_MS"];
    }
  });
});

describe("@agentmemory/mcp standalone — ~/.agentmemory/.env hydration", () => {
  const originalHome = process.env["HOME"];
  let sandboxHome: string;

  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-mcp-env-"));
    process.env["HOME"] = sandboxHome;
    mkdirSync(join(sandboxHome, ".agentmemory"));
    writeFileSync(join(sandboxHome, ".agentmemory", ".env"), "AGENTMEMORY_SECRET=from-file\n");
  });

  afterEach(() => {
    process.env["HOME"] = originalHome;
    delete process.env["AGENTMEMORY_SECRET"];
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it.each([
    ["unset", undefined],
    ["expanded to empty by the MCP host", ""],
    ["an unexpanded placeholder", "${AGENTMEMORY_SECRET:-}"],
  ])("fills the secret from the file when it is %s", (_label, value) => {
    if (value === undefined) delete process.env["AGENTMEMORY_SECRET"];
    else process.env["AGENTMEMORY_SECRET"] = value;

    hydrateMcpEnv();

    expect(process.env["AGENTMEMORY_SECRET"]).toBe("from-file");
  });

  it("keeps a real secret the MCP host passed", () => {
    process.env["AGENTMEMORY_SECRET"] = "from-host";

    hydrateMcpEnv();

    expect(process.env["AGENTMEMORY_SECRET"]).toBe("from-host");
  });
});

describe("@agentmemory/mcp standalone — resources and prompts proxy (rohitg00/agentmemory#846)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetHandleForTests();
    delete process.env["AGENTMEMORY_URL"];
    delete process.env["AGENTMEMORY_SECRET"];
  });

  afterEach(() => {
    resetHandleForTests();
    globalThis.fetch = originalFetch;
    delete process.env["AGENTMEMORY_URL"];
  });

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("proxies resources and prompts list/read/get to the server", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    installFetch((url, init) => {
      calls.push({ url, body: init?.body as string | undefined });
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/mcp/resources")) return json({ resources: [{ uri: "agentmemory://status" }] });
      if (url.endsWith("/mcp/resources/read")) return json({ contents: [{ uri: "agentmemory://status", text: "{}" }] });
      if (url.endsWith("/mcp/prompts")) return json({ prompts: [{ name: "recall_context" }] });
      if (url.endsWith("/mcp/prompts/get")) return json({ messages: [] });
      return new Response("", { status: 404 });
    });

    expect(await handleResourcesList()).toEqual({ resources: [{ uri: "agentmemory://status" }] });
    expect(await handlePromptsList()).toEqual({ prompts: [{ name: "recall_context" }] });
    expect(await handleResourcesRead("agentmemory://status")).toEqual({
      contents: [{ uri: "agentmemory://status", text: "{}" }],
    });
    expect(await handlePromptsGet("recall_context", { task_description: "x" })).toEqual({ messages: [] });

    const read = calls.find((c) => c.url.endsWith("/resources/read"));
    expect(JSON.parse(read!.body!)).toEqual({ uri: "agentmemory://status" });
    const get = calls.find((c) => c.url.endsWith("/prompts/get"));
    expect(JSON.parse(get!.body!)).toEqual({ name: "recall_context", arguments: { task_description: "x" } });
  });

  it("lists empty and refuses read/get when no server is reachable", async () => {
    installFetch(() => new Response("down", { status: 500 }));
    expect(await handleResourcesList()).toEqual({ resources: [] });
    expect(await handlePromptsList()).toEqual({ prompts: [] });
    await expect(handleResourcesRead("agentmemory://status")).rejects.toThrow(/running agentmemory server/);
    await expect(handlePromptsGet("recall_context", {})).rejects.toThrow(/running agentmemory server/);
  });
});

describe("@agentmemory/mcp standalone — explicit daemon must not fall back (rohitg00/agentmemory#273)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    resetHandleForTests();
    globalThis.fetch = originalFetch;
    delete process.env["AGENTMEMORY_URL"];
    delete process.env["AGENTMEMORY_FORCE_PROXY"];
  });

  it("errors naming the URL when AGENTMEMORY_URL is set and the daemon is down", async () => {
    resetHandleForTests();
    process.env["AGENTMEMORY_URL"] = "http://daemon.invalid:3111";
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const kv = new InMemoryKV();
    await expect(
      handleToolCall("memory_save", { content: "keep me" }, kv),
    ).rejects.toThrow("agentmemory daemon unreachable at http://daemon.invalid:3111");
    expect((await kv.list("mem:memories")).length).toBe(0);
  });

  it("fails Reflect promptly when the daemon does not answer its health probe", async () => {
    resetHandleForTests();
    process.env["AGENTMEMORY_URL"] = "http://127.0.0.1:3111";
    process.env["AGENTMEMORY_PROBE_TIMEOUT_MS"] = "50";
    const started = Date.now();
    (globalThis as { fetch: typeof fetch }).fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    try {
      await expect(handleToolCall("memory_reflect", {})).rejects.toThrow(/daemon unreachable/);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      delete process.env["AGENTMEMORY_PROBE_TIMEOUT_MS"];
    }
  });

  it("errors under AGENTMEMORY_FORCE_PROXY when the call cannot reach the daemon", async () => {
    resetHandleForTests();
    delete process.env["AGENTMEMORY_URL"];
    process.env["AGENTMEMORY_FORCE_PROXY"] = "1";
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(handleToolCall("memory_save", { content: "keep me" })).rejects.toThrow(
      "agentmemory daemon unreachable at http://localhost:3111",
    );
  });

  it("keeps the local fallback when no daemon URL was named", async () => {
    resetHandleForTests();
    delete process.env["AGENTMEMORY_URL"];
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const res = await handleToolCall("memory_save", { content: "local ok" }, new InMemoryKV());
    expect(res.content[0].text).toContain("saved");
  });
});

describe("agentmemory mcp — current project default", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    resetHandleForTests();
    globalThis.fetch = originalFetch;
  });

  it("proxies the cwd project when omitted and keeps an explicit one", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      bodies.push(JSON.parse((init?.body as string) || "{}"));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    await handleToolCall("memory_recall", { query: "x" });
    await handleToolCall("memory_recall", { query: "x", project: "other" });
    expect(bodies.map((b) => b["project"])).toEqual(["cwd-project", "other"]);
  });

  it("saves a Lesson that names no project under the cwd project (#377)", async () => {
    const bodies: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      bodies.push(JSON.parse((init?.body as string) || "{}"));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 });
    });
    await handleToolCall("memory_lesson_save", { content: "pin lockfiles" });
    expect(bodies[0].arguments["project"]).toBe("cwd-project");
  });

  it("names the cwd project when the daemon refuses a guessed Lesson project (#377)", async () => {
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      return new Response(
        JSON.stringify({ error: 'Unknown project "guessed": no Session or Lesson uses it.' }),
        { status: 400 },
      );
    });
    await expect(
      handleToolCall("memory_lesson_save", { content: "pin lockfiles", project: "guessed" }),
    ).rejects.toThrow('The current project is "cwd-project".');
  });
});
