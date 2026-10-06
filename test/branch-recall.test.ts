import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerContextFunction } from "../src/functions/context.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { KV } from "../src/state/schema.js";
import type {
  CompactSearchResult,
  CompressedObservation,
  HybridSearchResult,
  Session,
} from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const PROJECT = "project-p";

function sessionOn(id: string, branch: string, startedAt: string): Session {
  return {
    id,
    project: PROJECT,
    cwd: `/work/${PROJECT}/.worktrees/${branch}`,
    startedAt,
    status: "completed",
    observationCount: 1,
  };
}

const sessionOnA = sessionOn("ses_branch_a", "branch-a", "2026-10-01T00:00:00.000Z");
const sessionOnB = sessionOn("ses_branch_b", "branch-b", "2026-10-02T00:00:00.000Z");

const memoryFromA: CompressedObservation = {
  id: "obs_from_a",
  sessionId: sessionOnA.id,
  timestamp: "2026-10-01T00:01:00.000Z",
  type: "decision",
  title: "Retry budget lives in the client",
  facts: [],
  narrative: "Chose a client-side retry budget over server-side throttling",
  concepts: ["retry"],
  files: [],
  importance: 8,
};

describe("Recall is bounded by project, not branch", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(async () => {
    kv = mockKV();
    sdk = mockSdk();
    await kv.set(KV.sessions, sessionOnA.id, sessionOnA);
    await kv.set(KV.sessions, sessionOnB.id, sessionOnB);
    await kv.set(KV.observations(sessionOnA.id), memoryFromA.id, memoryFromA);
  });

  it("smart-search from a Session on branch B returns a Memory captured on branch A", async () => {
    const hit: HybridSearchResult = {
      observation: memoryFromA,
      bm25Score: 5,
      vectorScore: 0,
      combinedScore: 0.5,
      sessionId: sessionOnA.id,
    };
    registerSmartSearchFunction(sdk as never, kv as never, async () => [hit]);

    const result = (await sdk.trigger("mem::smart-search", {
      query: "retry budget",
      project: PROJECT,
    })) as { results: CompactSearchResult[] };

    expect(result.results.map((r) => r.obsId)).toEqual([memoryFromA.id]);
  });

  it("session-start context for a Session on branch B includes a Memory captured on branch A", async () => {
    registerContextFunction(sdk as never, kv as never, 4000);

    const { context } = (await sdk.trigger("mem::context", {
      sessionId: sessionOnB.id,
      project: PROJECT,
    })) as { context: string };

    expect(context).toContain(memoryFromA.title);
  });
});
