import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerRememberFunction } from "../src/functions/remember.js";
import { registerSearchFunction, getSearchIndex } from "../src/functions/search.js";
import { registerEnrichFunction } from "../src/functions/enrich.js";
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
    registerEnrichFunction(sdk as never, kv as never);
    registerDiagnosticsFunction(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never, SECRET);
    sdk.fns.set("mem::file-context", async () => ({ context: "" }));
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

    it("enrich from web injects a Global Memory saved in an api Session", async () => {
      await savedInApiSession("express-jwt whitespace breaks auth global", { global: true });
      const result = (await sdk.trigger("mem::enrich", {
        sessionId: "sess-web",
        files: ["src/auth.ts"],
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
