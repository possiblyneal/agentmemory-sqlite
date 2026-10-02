import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, h: Function) => {
      fns.set(id, h);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload),
    _fns: fns,
  };
}

describe("POST /agentmemory/session/start title (#276)", () => {
  it("records the title as firstPrompt and leaves summary to the summarizer", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never, undefined);
    sdk._fns.set("mem::context", () => ({ context: "" }));

    await sdk._fns.get("api::session::start")!({
      headers: {},
      body: { sessionId: "ses_1", project: "/p", cwd: "/p", title: "fix the flaky test" },
    });

    const session = await kv.get<Session>(KV.sessions, "ses_1");
    expect(session?.firstPrompt).toBe("fix the flaky test");
    expect(session).not.toHaveProperty("summary");
  });

  it("reopens an existing Session without resetting what it accumulated", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never, undefined);
    sdk._fns.set("mem::context", () => ({ context: "" }));
    const original: Session = {
      id: "ses_1",
      project: "/p",
      cwd: "/p",
      startedAt: "2026-10-01T00:00:00.000Z",
      endedAt: "2026-10-01T02:00:00.000Z",
      status: "completed",
      observationCount: 42,
      firstPrompt: "fix the flaky test",
      commitShas: ["abc123"],
    };
    await kv.set(KV.sessions, original.id, original);

    await sdk._fns.get("api::session::start")!({
      headers: {},
      body: { sessionId: "ses_1", project: "/p", cwd: "/p/sub", title: "a later prompt" },
    });

    const session = await kv.get<Session>(KV.sessions, "ses_1");
    expect(session).toEqual({
      ...original,
      cwd: "/p/sub",
      status: "active",
      endedAt: undefined,
      updatedAt: expect.any(String),
    });
    expect(session!.updatedAt! > original.endedAt!).toBe(true);
    expect(session).not.toHaveProperty("endedAt");
  });
});
