import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
}));

import { registerIdleSessionSweepFunction } from "../src/functions/idle-session-sweep.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    project: "p",
    cwd: "/p",
    startedAt: ago(20),
    status: "active",
    observationCount: 1,
    ...over,
  };
}

describe("mem::idle-session-sweep", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;
  let ended: string[];
  const original = process.env["SESSION_IDLE_CLOSE_HOURS"];

  const seed = (s: Session) => kv.set(KV.sessions, s.id, s);
  const sweep = () =>
    sdk.trigger({ function_id: "mem::idle-session-sweep", payload: {} }) as Promise<{
      closed: number;
    }>;
  const idOf = (req: unknown) => (req as { body: { sessionId: string } }).body.sessionId;

  beforeEach(() => {
    delete process.env["SESSION_IDLE_CLOSE_HOURS"];
    kv = mockKV();
    sdk = mockSdk();
    ended = [];
    // Stands in for POST /session/end, which marks completed and fires event::session::stopped.
    sdk.registerFunction("api::session::end", async (req: unknown) => {
      const id = idOf(req);
      ended.push(id);
      await kv.update(KV.sessions, id, [{ type: "set", path: "status", value: "completed" }]);
      return { status_code: 200 };
    });
    registerIdleSessionSweepFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    if (original === undefined) delete process.env["SESSION_IDLE_CLOSE_HOURS"];
    else process.env["SESSION_IDLE_CLOSE_HOURS"] = original;
  });

  it("closes only active Sessions idle past the window", async () => {
    await seed(session("idle", { updatedAt: ago(7) }));
    await seed(session("recent", { updatedAt: ago(1) }));
    await seed(session("never-observed-old"));
    await seed(session("done", { status: "completed", updatedAt: ago(30) }));

    const result = await sweep();

    expect(ended.sort()).toEqual(["idle", "never-observed-old"]);
    expect(result.closed).toBe(2);
  });

  it("is idempotent", async () => {
    await seed(session("idle", { updatedAt: ago(7) }));
    await sweep();
    const second = await sweep();
    expect(ended).toEqual(["idle"]);
    expect(second.closed).toBe(0);
  });

  it("keeps a Session that receives an Observation after the listing", async () => {
    await seed(session("a", { updatedAt: ago(8) }));
    await seed(session("b", { updatedAt: ago(8) }));
    const realList = kv.list;
    kv.list = (async (scope: string) => {
      const rows = await realList(scope);
      await kv.update(KV.sessions, "b", [
        { type: "set", path: "updatedAt", value: new Date().toISOString() },
      ]);
      return rows;
    }) as typeof kv.list;

    await sweep();

    expect(ended).toEqual(["a"]);
  });

  it("honors SESSION_IDLE_CLOSE_HOURS", async () => {
    process.env["SESSION_IDLE_CLOSE_HOURS"] = "48";
    await seed(session("idle", { updatedAt: ago(7) }));
    await sweep();
    expect(ended).toEqual([]);
  });

  it("continues past a Session whose close fails", async () => {
    await seed(session("a", { updatedAt: ago(8) }));
    await seed(session("b", { updatedAt: ago(8) }));
    sdk.registerFunction("api::session::end", async (req: unknown) => {
      const id = idOf(req);
      if (id === "a") throw new Error("boom");
      ended.push(id);
      return { status_code: 200 };
    });
    const result = await sweep();
    expect(ended).toEqual(["b"]);
    expect(result.closed).toBe(1);
  });
});
