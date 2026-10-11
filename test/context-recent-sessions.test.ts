import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerContextFunction } from "../src/functions/context.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session, SessionSummary } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function session(id: string, project: string, day: number): Session {
  return {
    id,
    project,
    cwd: project,
    startedAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    status: "completed",
    observationCount: 1,
  };
}

function summary(s: Session): SessionSummary {
  return {
    sessionId: s.id,
    project: s.project,
    createdAt: s.startedAt,
    title: `title of ${s.id}`,
    narrative: "n",
    keyDecisions: [],
    filesModified: [],
    concepts: [],
    observationCount: 1,
  };
}

describe("Session lookups avoid listing every Session (#196)", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;
  let sessionListings: number;

  beforeEach(() => {
    kv = mockKV();
    const list = kv.list;
    sessionListings = 0;
    kv.list = (async (scope: string) => {
      if (scope === KV.sessions) sessionListings++;
      return list(scope);
    }) as typeof kv.list;
    sdk = mockSdk();
    registerContextFunction(sdk as never, kv as never, 100000);
  });

  it("session-start context shows the 10 newest other Sessions of the project and none of another", async () => {
    const all: Session[] = [];
    for (let d = 1; d <= 14; d++) all.push(session(`ses_a${d}`, "/a", d));
    for (let d = 1; d <= 5; d++) all.push(session(`ses_b${d}`, "/b", d));
    all.push(session("ses_now", "/a", 20));
    for (const s of all) {
      await kv.set(KV.sessions, s.id, s);
      await kv.set(KV.summaries, s.id, summary(s));
    }

    const { context } = (await sdk.trigger("mem::context", {
      sessionId: "ses_now",
      project: "/a",
    })) as { context: string };

    const shown = [...context.matchAll(/title of (ses_\w+)/g)].map((m) => m[1]).sort();
    const expected = Array.from({ length: 10 }, (_, i) => `ses_a${i + 5}`).sort();
    expect(shown).toEqual(expected);
    expect(sessionListings).toBe(0);
  });

  it("expands an Observation id with no Session hint without listing Sessions", async () => {
    registerSmartSearchFunction(sdk as never, kv as never);
    const o: CompressedObservation = {
      id: "obs_far",
      sessionId: "ses_far",
      timestamp: "2026-10-01T00:00:00.000Z",
      type: "command_run",
      title: "far",
      facts: [],
      narrative: "far away",
      concepts: [],
      files: [],
      importance: 5,
    };
    for (let i = 0; i < 12; i++) await kv.set(KV.sessions, `ses_${i}`, session(`ses_${i}`, "/a", 1));
    await kv.set(KV.sessions, "ses_far", session("ses_far", "/a", 1));
    await kv.set(KV.observations("ses_far"), o.id, o);

    const result = (await sdk.trigger("mem::smart-search", { expandIds: ["obs_far"] })) as {
      results: Array<{ obsId: string; sessionId: string }>;
    };

    expect(result.results.map((r) => r.obsId)).toEqual(["obs_far"]);
    expect(sessionListings).toBe(0);
  });
});
