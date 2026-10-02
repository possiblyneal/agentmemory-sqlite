import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerFileIndexFunction } from "../src/functions/file-index.js";
import { getSearchIndex } from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function makeObs(sessionId: string, id: string, files: string[], title: string): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: "2026-10-01T00:00:00.000Z",
    type: "file_edit",
    title,
    facts: [],
    narrative: `${title} narrative`,
    concepts: [],
    files,
    importance: 6,
  };
}

describe("mem::file-context", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerFileIndexFunction(sdk as never, kv as never);
    getSearchIndex().clear();

    const session: Session = {
      id: "ses_old",
      project: "api",
      cwd: "/repo",
      startedAt: "2026-10-01T00:00:00.000Z",
      status: "completed",
      observationCount: 2,
    };
    await kv.set(KV.sessions, session.id, session);
    const hit = makeObs(session.id, "obs_hit", ["/repo/src/server.ts"], "Fixed server crash");
    const miss = makeObs(session.id, "obs_miss", ["/repo/src/other.ts"], "Touched other file");
    for (const obs of [hit, miss]) {
      await kv.set(KV.observations(session.id), obs.id, obs);
      getSearchIndex().add(obs);
    }
  });

  it("returns history for a file from the index without listing Session Observations", async () => {
    const list = vi.spyOn(kv, "list");

    const result = (await sdk.trigger("mem::file-context", {
      sessionId: "ses_now",
      files: ["src/server.ts"],
    })) as { context: string };

    expect(result.context).toContain("Fixed server crash");
    expect(result.context).not.toContain("Touched other file");
    expect(list).not.toHaveBeenCalledWith(KV.observations("ses_old"));
  });

  it("ignores Observations that are not in the index", async () => {
    getSearchIndex().clear();

    const result = (await sdk.trigger("mem::file-context", {
      sessionId: "ses_now",
      files: ["src/server.ts"],
    })) as { context: string };

    expect(result.context).toBe("");
  });
});
