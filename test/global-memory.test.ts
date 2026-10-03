import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerRememberFunction } from "../src/functions/remember.js";
import { registerSearchFunction, getSearchIndex } from "../src/functions/search.js";
import { registerPromptContextFunction } from "../src/functions/prompt-context.js";
import { registerDiagnosticsFunction } from "../src/functions/diagnostics.js";
import { inferMemoryProjects } from "../src/functions/migrate.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { memoryToIndexDoc } from "../src/state/memory-utils.js";
import { KV } from "../src/state/schema.js";
import type { DiagnosticCheck, Memory, Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const SECRET = "global-memory-secret";

function session(id: string, project: string): Session {
  return {
    id, project, cwd: `/srv/${project}`, startedAt: new Date().toISOString(),
    status: "active", observationCount: 0,
  };
}

describe("Global Memory (#95)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk({ looseTrigger: true });
    kv = mockKV();
    getSearchIndex().clear();
    registerRememberFunction(sdk as never, kv as never);
    registerSearchFunction(sdk as never, kv as never);
    registerPromptContextFunction(sdk as never, kv as never);
    registerDiagnosticsFunction(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never, SECRET);
    await kv.set(KV.sessions, "sess-api", session("sess-api", "api"));
    await kv.set(KV.sessions, "sess-web", session("sess-web", "web"));
  });

  async function remember(payload: Record<string, unknown>) {
    return (await sdk.trigger("mem::remember", payload)) as {
      success: boolean;
      error?: string;
      memory?: Memory;
    };
  }

  async function savedInApiSession(content: string, extra: Record<string, unknown> = {}) {
    const { memory } = await remember({ content, type: "bug", files: ["src/auth.ts"], ...extra });
    const attached = { ...memory!, sessionIds: ["sess-api"] };
    await kv.set(KV.memories, attached.id, attached);
    getSearchIndex().remove(attached.id);
    getSearchIndex().add(memoryToIndexDoc(attached));
    return attached;
  }

  describe("mem::remember", () => {
    it("stores the marker and no project", async () => {
      const result = await remember({ content: "always use tmux new -A", global: true });
      expect(result.success).toBe(true);
      const stored = await kv.get<Memory>(KV.memories, result.memory!.id);
      expect(stored?.global).toBe(true);
      expect(stored?.project).toBeUndefined();
    });

    it("leaves an unmarked Memory without the marker", async () => {
      const result = await remember({ content: "plain fact" });
      expect((await kv.get<Memory>(KV.memories, result.memory!.id))?.global).toBeUndefined();
    });

    it("refuses a project together with the marker", async () => {
      const result = await remember({ content: "x", global: true, project: "api" });
      expect(result.success).toBe(false);
      expect(await kv.list(KV.memories)).toHaveLength(0);
    });

    it("refuses a non-boolean marker", async () => {
      const result = await remember({ content: "x", global: "yes" });
      expect(result.success).toBe(false);
    });
  });

  describe("supersession keeps the marker where it was put", () => {
    const pref = "always run the test suite inside tmux before pushing any branch";

    it("an unmarked save does not supersede a Global Memory", async () => {
      const { memory: global } = await remember({ content: pref, global: true });
      const { memory: plain } = await remember({ content: `${pref} today` });
      expect((await kv.get<Memory>(KV.memories, global!.id))?.isLatest).not.toBe(false);
      expect(plain?.supersedes ?? []).not.toContain(global!.id);
    });

    it("a project save does not supersede a Global Memory", async () => {
      const { memory: global } = await remember({ content: pref, global: true });
      await remember({ content: `${pref} today`, project: "api" });
      expect((await kv.get<Memory>(KV.memories, global!.id))?.isLatest).not.toBe(false);
    });

    it("a global save does not supersede a project Memory", async () => {
      const { memory: scoped } = await remember({ content: pref, project: "web" });
      await remember({ content: `${pref} today`, global: true });
      expect((await kv.get<Memory>(KV.memories, scoped!.id))?.isLatest).not.toBe(false);
    });

    it("a global save supersedes a Global Memory and stays global", async () => {
      const { memory: old } = await remember({ content: pref, global: true });
      const { memory: next } = await remember({ content: `${pref} today`, global: true });
      expect((await kv.get<Memory>(KV.memories, old!.id))?.isLatest).toBe(false);
      expect((await kv.get<Memory>(KV.memories, next!.id))?.global).toBe(true);
    });
  });

  it("search does not treat a non-boolean stored marker as global", async () => {
    const attached = await savedInApiSession("tmux imported marker");
    await kv.set(KV.memories, attached.id, { ...attached, global: "yes" });
    const result = (await sdk.trigger("mem::search", { query: "tmux", project: "web" })) as {
      results: unknown[];
    };
    expect(result.results).toHaveLength(0);
  });

  describe("a project's list and mesh export include Global Memories", () => {
    const get = (fn: string, query_params: Record<string, string>) =>
      sdk.fns.get(fn)!({ headers: { authorization: `Bearer ${SECRET}` }, query_params }) as Promise<{
        status_code: number;
        body: { memories: Memory[] };
      }>;

    beforeEach(async () => {
      await remember({ content: "global preference", global: true });
      await remember({ content: "web only", project: "web" });
      await remember({ content: "api only", project: "api" });
    });

    it("GET /memories?project=web", async () => {
      const contents = (await get("api::memories", { project: "web" })).body.memories.map((m) => m.content);
      expect(contents.sort()).toEqual(["global preference", "web only"]);
    });

    it("mesh export of web", async () => {
      const contents = (await get("api::mesh-export", { project: "web" })).body.memories.map((m) => m.content);
      expect(contents.sort()).toEqual(["global preference", "web only"]);
    });
  });

  describe("Recall from another project", () => {
    it("search from web returns a Global Memory saved in an api Session, and not an unmarked one", async () => {
      await savedInApiSession("tmux preference global marker", { global: true });
      await savedInApiSession("tmux habit pinned to api");

      const result = (await sdk.trigger("mem::search", { query: "tmux", project: "web" })) as {
        results: Array<{ observation: { title: string } }>;
      };
      const titles = result.results.map((r) => r.observation.title);
      expect(titles).toContain("tmux preference global marker");
      expect(titles).not.toContain("tmux habit pinned to api");
    });

    it("a prompt from web injects a Global Memory saved in an api Session", async () => {
      for (const content of ["tmux pane layout", "postgres vacuum schedule", "docker cache busting", "ci matrix trimmed"]) {
        await remember({ content, project: "api" });
      }
      await savedInApiSession("express-jwt whitespace breaks auth global", { global: true });
      const result = (await sdk.trigger("mem::prompt-context", {
        sessionId: "sess-web",
        prompt: "why does express-jwt whitespace break auth",
        project: "web",
      })) as { context: string };
      expect(result.context).toContain("express-jwt whitespace breaks auth global");
    });
  });

  it("memory-project-coverage counts an unmarked project-less Memory and not a Global one", async () => {
    await remember({ content: "global preference", global: true });
    await remember({ content: "accidentally unscoped" });

    const result = (await sdk.trigger("mem::diagnose", { categories: ["memories"] })) as {
      checks: DiagnosticCheck[];
    };
    const coverage = result.checks.find((c) => c.name === "memory-project-coverage");
    expect(coverage?.message).toMatch(/^1 of 2 latest memories have no project scope/);
  });

  it("the project-inference migration leaves a Global Memory's project unset", async () => {
    const memory = await savedInApiSession("global preference", { global: true });
    await inferMemoryProjects(kv as never);
    expect((await kv.get<Memory>(KV.memories, memory.id))?.project).toBeUndefined();
  });

  describe("boundaries", () => {
    const rest = (body: Record<string, unknown>) =>
      sdk.fns.get("api::remember")!({
        headers: { authorization: `Bearer ${SECRET}` },
        body,
      }) as Promise<{ status_code: number; body: { memory?: Memory } }>;

    it("REST forwards the marker", async () => {
      const response = await rest({ content: "global via rest", global: true });
      expect(response.status_code).toBe(201);
      expect(response.body.memory?.global).toBe(true);
    });

    it.each([
      ["a non-boolean marker", { global: "true" }],
      ["a project with the marker", { global: true, project: "api" }],
    ])("REST answers 400 to %s", async (_, extra) => {
      expect((await rest({ content: "x", ...extra })).status_code).toBe(400);
    });

    function mcp() {
      const payloads: Record<string, unknown>[] = [];
      const fns = new Map<string, Function>();
      const mcpSdk = {
        registerFunction: (id: string, h: Function) => fns.set(id, h),
        registerTrigger: () => {},
        trigger: async (input: { payload: Record<string, unknown> }) => {
          payloads.push(input.payload);
          return { success: true };
        },
      };
      registerMcpEndpoints(mcpSdk as never, kv as never, SECRET);
      const save = (args: Record<string, unknown>) =>
        fns.get("mcp::tools::call")!({
          headers: { authorization: `Bearer ${SECRET}` },
          body: { name: "memory_save", arguments: args },
        }) as Promise<{ status_code: number }>;
      return { save, payloads };
    }

    it("MCP memory_save forwards the marker", async () => {
      const { save, payloads } = mcp();
      expect((await save({ content: "x", global: true })).status_code).toBe(200);
      expect(payloads[0]).toMatchObject({ global: true });
    });

    it.each([
      ["a non-boolean marker", { global: "true" }],
      ["a project with the marker", { global: true, project: "api" }],
    ])("MCP memory_save answers 400 to %s", async (_, extra) => {
      const { save, payloads } = mcp();
      expect((await save({ content: "x", ...extra })).status_code).toBe(400);
      expect(payloads).toHaveLength(0);
    });
  });
});
