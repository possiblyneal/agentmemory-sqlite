import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { withKeyedLock } from "../src/state/keyed-mutex.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const SESSION: Session = {
  id: "ses_1",
  project: "api",
  cwd: "/repo",
  startedAt: "2026-10-02T00:00:00.000Z",
  status: "active",
  observationCount: 1,
};

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("api::session::commit Session write", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  const linkCommit = (sha: string, sessionId = SESSION.id) =>
    sdk.fns.get("api::session::commit")!({ headers: {}, body: { sha, sessionId } });

  beforeEach(async () => {
    sdk = mockSdk({ looseTrigger: true });
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, undefined);
    registerObserveFunction(sdk as never, kv as never);
    await kv.set(KV.sessions, SESSION.id, { ...SESSION });
  });

  it("queues behind observe on the Session's lock and keeps its count and activity time", async () => {
    let writes: Promise<unknown[]> | undefined;
    await withKeyedLock(`obs:${SESSION.id}`, async () => {
      writes = Promise.all([
        sdk.trigger("mem::observe", {
          sessionId: SESSION.id,
          hookType: "post_tool_use",
          timestamp: "2026-10-02T01:00:00.000Z",
          data: { tool_name: "Read", tool_input: { file_path: "a.ts" } },
        }),
        linkCommit("aaa1111"),
      ]);
      await settle();
      expect(await kv.get<Session>(KV.sessions, SESSION.id)).toEqual(SESSION);
    });
    await writes;

    const session = await kv.get<Session>(KV.sessions, SESSION.id);
    expect(session?.observationCount).toBe(2);
    expect(session?.updatedAt).toBeDefined();
    expect(session?.commitShas).toEqual(["aaa1111"]);
  });

  it("keeps two SHAs from three concurrent links, one of them repeated", async () => {
    await Promise.all([linkCommit("aaa1111"), linkCommit("bbb2222"), linkCommit("aaa1111")]);

    const session = await kv.get<Session>(KV.sessions, SESSION.id);
    expect([...(session?.commitShas ?? [])].sort()).toEqual(["aaa1111", "bbb2222"]);
  });

  it("links a commit to an unknown Session without creating the Session", async () => {
    const res = (await linkCommit("ccc3333", "ses_missing")) as { status_code: number };

    expect(res.status_code).toBe(200);
    expect(await kv.get(KV.sessions, "ses_missing")).toBeNull();
  });
});
