import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerPromptContextFunction } from "../src/functions/prompt-context.js";
import { resetInjectionGate } from "../src/functions/prompt-rerank.js";
import { resetLessonIndex } from "../src/functions/lessons.js";
import { KV } from "../src/state/schema.js";
import type { InjectionRecord, Lesson } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

interface PromptContext {
  context: string;
  injected: Array<{ kind: string; id: string }>;
}

const PROMPT = "the homelab check script fails on shellcheck warnings";
const ENV_KEYS = [
  "AGENTMEMORY_PROMPT_RERANK",
  "AGENTMEMORY_PROMPT_RERANK_URL",
  "AGENTMEMORY_PROMPT_RERANK_MIN",
  "AGENTMEMORY_PROMPT_LESSON_MIN",
];

function lesson(id: string, overrides: Partial<Lesson> = {}): Lesson {
  return {
    id,
    content: `Run shellcheck with -x in the check script (${id})`,
    context: `check script shellcheck warnings fail (${id})`,
    confidence: 0.5,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    project: "homelab",
    tags: [],
    createdAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
    decayRate: 0.05,
    ...overrides,
  };
}

describe("mem::prompt-context Lessons", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let observationIds: string[];
  let server: Server;
  let requests: Array<{ query: string; documents: string[] }>;
  let scoreOf: (doc: string) => number;
  let failing: boolean;
  const savedEnv: Record<string, string | undefined> = {};

  const run = (sessionId = "ses_1") =>
    sdk.trigger("mem::prompt-context", { sessionId, project: "homelab", prompt: PROMPT }) as Promise<PromptContext>;

  const scores = (byMarker: Record<string, number>) => (doc: string) =>
    Object.entries(byMarker).find(([marker]) => doc.includes(`(${marker})`) || doc.endsWith(`of ${marker}`))?.[1] ?? 0;

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    resetInjectionGate();
    resetLessonIndex();
    requests = [];
    failing = false;
    scoreOf = () => 0;
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw) as { query: string; documents: string[] };
        requests.push(body);
        if (failing) {
          res.writeHead(500);
          res.end("boom");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            results: body.documents.map((doc, index) => ({ index, relevance_score: scoreOf(doc) })),
          }),
        );
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    process.env.AGENTMEMORY_PROMPT_RERANK = "on";
    process.env.AGENTMEMORY_PROMPT_RERANK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/rerank`;
    process.env.AGENTMEMORY_PROMPT_RERANK_MIN = "0.03";
    delete process.env.AGENTMEMORY_PROMPT_LESSON_MIN;

    sdk = mockSdk();
    kv = mockKV();
    observationIds = ["obs_a", "obs_b", "obs_c"];
    sdk.registerFunction("mem::search", async () => ({
      results: observationIds.map((id, i) => ({
        score: 20 - i * 0.1,
        sessionId: "ses_old",
        observation: { id, narrative: `narrative of ${id}` },
      })),
    }));
    registerPromptContextFunction(sdk as never, kv as never);
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });

  it("injects the best-matching Lesson when the reranker scores it at 0.5 or more", async () => {
    await kv.set(KV.lessons, "lsn_1", lesson("lsn_1"));
    scoreOf = scores({ lsn_1: 0.6, obs_a: 0.9, obs_b: 0.3 });
    const result = await run();
    expect(result.injected).toEqual([
      { kind: "observation", id: "obs_a" },
      { kind: "lesson", id: "lsn_1" },
      { kind: "observation", id: "obs_b" },
    ]);
    expect(result.context).toContain("Run shellcheck with -x in the check script (lsn_1)");
    expect(result.context).toContain("check script shellcheck warnings fail (lsn_1)");
  });

  it("leaves out a Lesson below the Lesson floor that an Observation at that score would pass", async () => {
    await kv.set(KV.lessons, "lsn_1", lesson("lsn_1"));
    scoreOf = scores({ lsn_1: 0.4, obs_a: 0.4 });
    expect((await run()).injected).toEqual([{ kind: "observation", id: "obs_a" }]);
  });

  it("takes the Lesson floor from AGENTMEMORY_PROMPT_LESSON_MIN", async () => {
    process.env.AGENTMEMORY_PROMPT_LESSON_MIN = "0.3";
    await kv.set(KV.lessons, "lsn_1", lesson("lsn_1"));
    scoreOf = scores({ lsn_1: 0.4 });
    expect((await run()).injected).toEqual([{ kind: "lesson", id: "lsn_1" }]);
  });

  it("gives the Lesson the last of the ten reranked places instead of growing the pool", async () => {
    observationIds = Array.from({ length: 14 }, (_, i) => `obs_${i}`);
    await kv.set(KV.lessons, "lsn_1", lesson("lsn_1"));
    await run();
    expect(requests[0].documents).toHaveLength(10);
    expect(requests[0].documents.slice(0, 9)).toEqual(observationIds.slice(0, 9).map((id) => `narrative of ${id}`));
    expect(requests[0].documents[9]).toContain("(lsn_1)");
  });

  it("reranks one Lesson at most, the best BM25 match", async () => {
    await kv.set(KV.lessons, "lsn_best", lesson("lsn_best", { content: "shellcheck check script shellcheck warnings homelab (lsn_best)" }));
    await kv.set(KV.lessons, "lsn_other", lesson("lsn_other"));
    scoreOf = (doc) => (doc.includes("(lsn_") ? 0.95 : 0.9);
    const result = await run();
    const lessonDocs = requests[0].documents.filter((d) => d.includes("(lsn_"));
    expect(lessonDocs).toHaveLength(1);
    expect(lessonDocs[0]).toContain("(lsn_best)");
    expect(result.injected.filter((r) => r.kind === "lesson")).toEqual([{ kind: "lesson", id: "lsn_best" }]);
  });

  it("reranks the newer of two near-twin Lessons, even when the older matches the prompt better", async () => {
    await kv.set(
      KV.lessons,
      "lsn_old",
      lesson("lsn_old", { content: "Run shellcheck with -x in the check script on warnings (lsn_old)" }),
    );
    await kv.set(
      KV.lessons,
      "lsn_new",
      lesson("lsn_new", {
        content: "Run shellcheck without -x in the check script (lsn_new)",
        createdAt: "2026-11-08T10:00:00.000Z",
        updatedAt: "2026-11-08T10:00:00.000Z",
      }),
    );
    await run();
    const lessonDocs = requests[0].documents.filter((d) => d.includes("(lsn_"));
    expect(lessonDocs).toHaveLength(1);
    expect(lessonDocs[0]).toContain("(lsn_new)");
  });

  it("considers this project's and global Lessons only, never a deleted or already-injected one", async () => {
    await kv.set(KV.lessons, "lsn_elsewhere", lesson("lsn_elsewhere", { project: "devex" }));
    await kv.set(KV.lessons, "lsn_deleted", lesson("lsn_deleted", { deleted: true }));
    await kv.set(KV.lessons, "lsn_seen", lesson("lsn_seen"));
    await kv.set<InjectionRecord>(KV.injections, "inj_1", {
      id: "inj_1",
      source: "session-start",
      sessionId: "ses_1",
      injected: [{ kind: "lesson", id: "lsn_seen" }],
      tokens: 10,
      at: "2026-11-05T11:00:00.000Z",
    });
    await run();
    expect(requests[0].documents.some((d) => d.includes("(lsn_"))).toBe(false);

    await kv.set(KV.lessons, "lsn_global", lesson("lsn_global", { project: undefined }));
    resetLessonIndex();
    await run();
    const lessonDocs = requests[1].documents.filter((d) => d.includes("(lsn_"));
    expect(lessonDocs).toHaveLength(1);
    expect(lessonDocs[0]).toContain("(lsn_global)");
  });

  it("injects no Lesson when the gate fails, keeping the BM25 selection", async () => {
    await kv.set(KV.lessons, "lsn_1", lesson("lsn_1"));
    failing = true;
    expect((await run()).injected.map((r) => r.id)).toEqual(["obs_a", "obs_b", "obs_c"]);
  });

  it("injects no Lesson when the gate is off", async () => {
    process.env.AGENTMEMORY_PROMPT_RERANK = "off";
    await kv.set(KV.lessons, "lsn_1", lesson("lsn_1"));
    expect((await run()).injected.map((r) => r.id)).toEqual(["obs_a", "obs_b", "obs_c"]);
    expect(requests).toEqual([]);
  });
});
