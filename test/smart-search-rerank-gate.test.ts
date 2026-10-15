import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { resetInjectionGate } from "../src/functions/prompt-rerank.js";
import type { CompactSearchResult, CompressedObservation, HybridSearchResult } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

type Reply = { status?: number; scores?: number[] };

const ENV_KEYS = ["AGENTMEMORY_PROMPT_RERANK", "AGENTMEMORY_PROMPT_RERANK_URL", "AGENTMEMORY_PROMPT_RERANK_MIN"];

function hit(id: string, bm25Score: number): HybridSearchResult {
  const observation = {
    id,
    sessionId: "ses_1",
    timestamp: "2026-02-01T10:00:00Z",
    type: "decision",
    title: `title ${id}`,
    facts: [],
    narrative: `narrative of ${id}`,
    concepts: [],
    files: [],
    importance: 5,
  } as CompressedObservation;
  return { observation, bm25Score, vectorScore: 0, combinedScore: 0.01, sessionId: "ses_1" };
}

describe("mem::smart-search is not reranker-gated", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let server: Server;
  let requests: Array<{ query: string; documents: string[] }>;
  let reply: Reply;
  const savedEnv: Record<string, string | undefined> = {};

  const search = async (query = "what are we using redis for") =>
    ((await sdk.trigger("mem::smart-search", { query })) as { results: CompactSearchResult[] }).results.map(
      (r) => r.obsId,
    );

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    resetInjectionGate();
    requests = [];
    reply = {};
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw) as { query: string; documents: string[] };
        requests.push(body);
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            results: body.documents.map((_doc, index) => ({
              index,
              relevance_score: reply.scores?.[index] ?? 0,
            })),
          }),
        );
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    process.env.AGENTMEMORY_PROMPT_RERANK = "on";
    process.env.AGENTMEMORY_PROMPT_RERANK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/rerank`;
    process.env.AGENTMEMORY_PROMPT_RERANK_MIN = "0.03";

    sdk = mockSdk();
    const hits = [hit("obs_a", 9), hit("obs_b", 8), hit("obs_c", 7)];
    registerSmartSearchFunction(sdk as never, mockKV() as never, async () => hits);
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });

  it("returns every hit in BM25 order and never calls the reranker, even when it would score them all below the floor", async () => {
    reply = { scores: [0.01, 0.02, 0] };
    expect(await search()).toEqual(["obs_a", "obs_b", "obs_c"]);
    expect(requests).toHaveLength(0);
  });
});
