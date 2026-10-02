import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
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
    sdk = mockSdk();
    kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, undefined);
    await kv.set(KV.sessions, SESSION.id, { ...SESSION });
  });

  it("waits for the Session's observe lock and keeps the count observe wrote", async () => {
    let link: Promise<unknown> | undefined;
    await withKeyedLock(`obs:${SESSION.id}`, async () => {
      link = linkCommit("aaa1111");
      await settle();
      const midway = await kv.get<Session>(KV.sessions, SESSION.id);
      expect(midway?.commitShas).toBeUndefined();
      await kv.update(KV.sessions, SESSION.id, [
        { type: "set", path: "observationCount", value: 2 },
      ]);
    });
    await link;

    const session = await kv.get<Session>(KV.sessions, SESSION.id);
    expect(session?.observationCount).toBe(2);
    expect(session?.commitShas).toEqual(["aaa1111"]);
  });

  it("keeps both of two concurrent commits and does not repeat a SHA", async () => {
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
