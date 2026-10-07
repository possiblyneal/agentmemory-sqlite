import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerPromptContextFunction } from "../src/functions/prompt-context.js";
import { promptGateState, resetPromptGate } from "../src/functions/prompt-rerank.js";
import { getPromptRerankConfig } from "../src/config.js";
import { logger } from "../src/logger.js";
import { KV } from "../src/state/schema.js";
import type { InjectionRecord } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

interface Hit {
  id: string;
  score: number;
  title?: string;
  narrative?: string;
}

interface PromptContext {
  context: string;
  injected: Array<{ kind: string; id: string }>;
}

type Reply = { status?: number; body?: string; hang?: boolean };

const PROMPT = "staging auth fails when SHIPCTL_TOKEN is unset";
const ENV_KEYS = [
  "AGENTMEMORY_PROMPT_RERANK",
  "AGENTMEMORY_PROMPT_RERANK_URL",
  "AGENTMEMORY_PROMPT_RERANK_MIN",
  "AGENTMEMORY_PROMPT_RERANK_TIMEOUT_MS",
];

describe("mem::prompt-context reranker gate", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let hits: Hit[];
  let server: Server;
  let requests: Array<{ query: string; documents: string[] }>;
  let reply: (req: { query: string; documents: string[] }) => Reply;
  const savedEnv: Record<string, string | undefined> = {};

  const run = (prompt = PROMPT, sessionId = "ses_1") =>
    sdk.trigger("mem::prompt-context", { sessionId, project: "shipctl", prompt }) as Promise<PromptContext>;

  const scoring = (scores: Record<string, number>) => (req: { documents: string[] }): Reply => ({
    body: JSON.stringify({
      results: req.documents.map((doc, index) => ({
        index,
        relevance_score: scores[doc.replace(/^.*narrative of /, "")] ?? 0,
      })),
    }),
  });

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    resetPromptGate();
    requests = [];
    reply = scoring({});
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw);
        requests.push(body);
        const answer = reply(body);
        if (answer.hang) return;
        res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
        res.end(answer.body ?? "{}");
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    process.env.AGENTMEMORY_PROMPT_RERANK = "on";
    process.env.AGENTMEMORY_PROMPT_RERANK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/rerank`;
    process.env.AGENTMEMORY_PROMPT_RERANK_MIN = "0.03";

    sdk = mockSdk();
    kv = mockKV();
    hits = [];
    sdk.registerFunction("mem::search", async () => ({
      results: hits.map((h) => ({
        score: h.score,
        sessionId: "ses_old",
        observation: { id: h.id, title: h.title, narrative: h.narrative ?? `narrative of ${h.id}` },
      })),
    }));
    registerPromptContextFunction(sdk as never, kv as never);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.mocked(logger.warn).mockClear();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });

  const bm25Hits = (): Hit[] => [
    { id: "obs_a", score: 16 },
    { id: "obs_b", score: 14 },
    { id: "obs_c", score: 12 },
  ];

  it("drops candidates below the threshold and orders the rest by score", async () => {
    hits = bm25Hits();
    reply = scoring({ obs_a: 0.01, obs_b: 0.4, obs_c: 0.9 });
    expect((await run()).injected.map((r) => r.id)).toEqual(["obs_c", "obs_b"]);
  });

  it("injects nothing when every candidate is gated out", async () => {
    hits = bm25Hits();
    reply = scoring({ obs_a: 0.001, obs_b: 0.002, obs_c: 0.0 });
    const result = await run();
    expect(result).toEqual({ context: "", tokens: 0, injected: [] });
  });

  it("never adds a candidate that failed the BM25 floor or was already injected", async () => {
    await kv.set<InjectionRecord>(KV.injections, "inj_1", {
      id: "inj_1",
      source: "session-start",
      sessionId: "ses_1",
      injected: [{ kind: "observation", id: "obs_seen" }],
      tokens: 10,
      at: "2026-10-03T00:00:00.000Z",
    });
    hits = [
      { id: "obs_seen", score: 20 },
      { id: "obs_a", score: 16 },
      { id: "obs_weak", score: 2 },
    ];
    reply = scoring({ obs_seen: 0.99, obs_a: 0.5, obs_weak: 0.99 });
    const result = await run();
    expect(result.injected.map((r) => r.id)).toEqual(["obs_a"]);
    expect(requests[0].documents).toEqual(["narrative of obs_a"]);
  });

  it("still injects at most three after gating", async () => {
    hits = [...bm25Hits(), { id: "obs_d", score: 11 }];
    reply = scoring({ obs_a: 0.1, obs_b: 0.2, obs_c: 0.3, obs_d: 0.4 });
    expect((await run()).injected.map((r) => r.id)).toEqual(["obs_d", "obs_c", "obs_b"]);
  });

  it("bounds the request: query to 500 chars, narrative to 400, title prefixed", async () => {
    hits = [{ id: "obs_a", score: 16, title: "Auth fix", narrative: "n".repeat(900) }];
    reply = scoring({});
    await run(`${"token ".repeat(200)}`);
    expect(requests[0].query).toHaveLength(500);
    expect(requests[0].documents).toEqual([`Auth fix ${"n".repeat(400)}`]);
  });

  it("records what was injected after gating", async () => {
    hits = bm25Hits();
    reply = scoring({ obs_a: 0.5 });
    const result = await run();
    expect(result.injected).toEqual([{ kind: "observation", id: "obs_a" }]);
    expect(result.context).toContain("narrative of obs_a");
    expect(result.context).not.toContain("narrative of obs_b");
  });

  describe("fails open to the BM25 selection", () => {
    const bm25Ids = ["obs_a", "obs_b", "obs_c"];

    beforeEach(() => {
      hits = bm25Hits();
    });

    it("on a 500 reply", async () => {
      reply = () => ({ status: 500, body: "boom" });
      expect((await run()).injected.map((r) => r.id)).toEqual(bm25Ids);
      expect(promptGateState().lastFailure?.reason).toBe("http_500");
    });

    it.each([
      ["non-JSON", "not json"],
      ["no results array", "{}"],
      ["an index out of range", JSON.stringify({ results: [{ index: 7, relevance_score: 0.9 }] })],
      ["a non-numeric score", JSON.stringify({ results: [{ index: 0, relevance_score: "high" }] })],
    ])("on a malformed body: %s", async (_name, body) => {
      reply = () => ({ body });
      expect((await run()).injected.map((r) => r.id)).toEqual(bm25Ids);
      expect(promptGateState().lastFailure?.reason).toBe("malformed");
    });

    it("on a timeout", async () => {
      process.env.AGENTMEMORY_PROMPT_RERANK_TIMEOUT_MS = "150";
      reply = () => ({ hang: true });
      expect((await run()).injected.map((r) => r.id)).toEqual(bm25Ids);
      expect(promptGateState().lastFailure?.reason).toBe("timeout");
    });

    it("on a refused connection", async () => {
      const closed = createServer();
      await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
      const port = (closed.address() as AddressInfo).port;
      await new Promise((done) => closed.close(done));
      process.env.AGENTMEMORY_PROMPT_RERANK_URL = `http://127.0.0.1:${port}/v1/rerank`;
      expect((await run()).injected.map((r) => r.id)).toEqual(bm25Ids);
      expect(promptGateState().lastFailure?.reason).toBe("connection");
    });
  });

  describe("cooldown", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      hits = bm25Hits();
    });

    it("skips the endpoint for 60s after a failure, then resumes, warning once", async () => {
      reply = () => ({ status: 500 });
      await run();
      expect(requests).toHaveLength(1);

      vi.advanceTimersByTime(59_000);
      expect((await run()).injected.map((r) => r.id)).toEqual(["obs_a", "obs_b", "obs_c"]);
      expect(requests).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_000);
      reply = scoring({ obs_c: 0.8 });
      expect((await run()).injected.map((r) => r.id)).toEqual(["obs_c"]);
      expect(requests).toHaveLength(2);
    });
  });

  it("never calls the endpoint when disabled, and returns the BM25 selection", async () => {
    for (const off of ["off", "false", "0"]) {
      process.env.AGENTMEMORY_PROMPT_RERANK = off;
      hits = bm25Hits();
      reply = scoring({});
      expect((await run()).injected.map((r) => r.id)).toEqual(["obs_a", "obs_b", "obs_c"]);
    }
    expect(requests).toEqual([]);
  });

  it("reports gate state for /diagnostics", async () => {
    hits = bm25Hits();
    reply = scoring({ obs_a: 0.5 });
    await run();
    expect(promptGateState()).toMatchObject({ enabled: true, calls: 1, fallbacks: 0, lastFailure: null });
  });
});

describe("getPromptRerankConfig", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("defaults to on with the ai host, 0.03 and 1000 ms", () => {
    expect(getPromptRerankConfig()).toEqual({
      enabled: true,
      url: "http://ai.lan:9202/v1/rerank",
      minScore: 0.03,
      timeoutMs: 1000,
    });
  });

  it("falls back to the defaults for invalid values", () => {
    process.env.AGENTMEMORY_PROMPT_RERANK_URL = "not a url";
    process.env.AGENTMEMORY_PROMPT_RERANK_MIN = "abc";
    process.env.AGENTMEMORY_PROMPT_RERANK_TIMEOUT_MS = "-5";
    expect(getPromptRerankConfig()).toMatchObject({
      url: "http://ai.lan:9202/v1/rerank",
      minScore: 0.03,
      timeoutMs: 1000,
    });
  });

  it("accepts valid overrides", () => {
    process.env.AGENTMEMORY_PROMPT_RERANK_URL = "http://10.0.0.5:9000/v1/rerank";
    process.env.AGENTMEMORY_PROMPT_RERANK_MIN = "0.2";
    process.env.AGENTMEMORY_PROMPT_RERANK_TIMEOUT_MS = "250";
    expect(getPromptRerankConfig()).toEqual({
      enabled: true,
      url: "http://10.0.0.5:9000/v1/rerank",
      minScore: 0.2,
      timeoutMs: 250,
    });
  });
});
