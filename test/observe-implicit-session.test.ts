import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mockKV } from "./helpers/mocks.js";

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    fns,
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: Function,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

describe("observe implicit session create (#638)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("creates the session on first observe when project+cwd present and session record missing", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_plugin_abc",
      project: "/home/user/myrepo",
      cwd: "/home/user/myrepo",
      hookType: "prompt_submit",
      timestamp: new Date().toISOString(),
      data: { prompt: "ship the helm chart" },
    })) as { observationId: string };

    expect(result.observationId).toBeTruthy();

    const sessionScope = kv.store.get("mem:sessions");
    expect(sessionScope).toBeTruthy();
    const session = sessionScope!.get("ses_plugin_abc") as Record<string, unknown>;
    expect(session).toBeTruthy();
    expect(session.id).toBe("ses_plugin_abc");
    expect(session.project).toBe("/home/user/myrepo");
    expect(session.cwd).toBe("/home/user/myrepo");
    expect(session.status).toBe("active");
    expect(session.observationCount).toBe(1);
    expect(session.firstPrompt).toBe("ship the helm chart");
  });

  it("does not implicit-create when project+cwd missing (test-payload back-compat)", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_no_project",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read", tool_input: { file_path: "x.ts" } },
    });

    const sessionScope = kv.store.get("mem:sessions");
    // Either no scope at all, or no entry for this session
    expect(sessionScope?.get("ses_no_project")).toBeUndefined();
  });

  it("does not overwrite an existing session when one already exists", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_existing", {
      id: "ses_existing",
      project: "/orig/project",
      cwd: "/orig/cwd",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 7,
      firstPrompt: "original first prompt",
    });

    await sdk.trigger("mem::observe", {
      sessionId: "ses_existing",
      project: "/different/project",
      cwd: "/different/cwd",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    });

    const session = kv.store.get("mem:sessions")!.get("ses_existing") as Record<string, unknown>;
    // Original project + firstPrompt preserved
    expect(session.project).toBe("/orig/project");
    expect(session.firstPrompt).toBe("original first prompt");
    // Counter bumped, updatedAt refreshed
    expect(session.observationCount).toBe(8);
    expect(session.updatedAt).toBeTruthy();
  });

  it("reopens an Abandoned Session when work arrives on it", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_idle", {
      id: "ses_idle",
      project: "/p",
      cwd: "/p",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T01:00:00Z",
      status: "abandoned",
      observationCount: 3,
    });

    await sdk.trigger("mem::observe", {
      sessionId: "ses_idle",
      project: "/p",
      cwd: "/p",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    });

    const session = kv.store.get("mem:sessions")!.get("ses_idle") as Record<string, unknown>;
    expect(session.status).toBe("active");
    expect(session).not.toHaveProperty("endedAt");
    expect(session.observationCount).toBe(4);
  });

  it("reopens a Session the idle sweep closed", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_swept", {
      id: "ses_swept",
      project: "/p",
      cwd: "/p",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T07:00:00Z",
      status: "completed",
      idleClosed: true,
      observationCount: 3,
    });

    await sdk.trigger("mem::observe", {
      sessionId: "ses_swept",
      project: "/p",
      cwd: "/p",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    });

    const session = kv.store.get("mem:sessions")!.get("ses_swept") as Record<string, unknown>;
    expect(session.status).toBe("active");
    expect(session).not.toHaveProperty("endedAt");
    expect(session).not.toHaveProperty("idleClosed");
  });

  it("leaves a Session that ended normally ended", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_done", {
      id: "ses_done",
      project: "/p",
      cwd: "/p",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T01:00:00Z",
      status: "completed",
      observationCount: 3,
    });

    await sdk.trigger("mem::observe", {
      sessionId: "ses_done",
      project: "/p",
      cwd: "/p",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    });

    const session = kv.store.get("mem:sessions")!.get("ses_done") as Record<string, unknown>;
    expect(session.status).toBe("completed");
    expect(session.endedAt).toBe("2026-01-01T01:00:00Z");
  });
});
