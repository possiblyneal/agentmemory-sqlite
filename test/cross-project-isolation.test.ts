import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

vi.mock("../src/functions/audit.js", () => ({
  recordAudit: vi.fn(),
}));

vi.mock("../src/functions/access-tracker.js", () => ({
  recordAccessBatch: vi.fn(),
  deleteAccessLog: vi.fn(),
}));

// Partial mock: search.ts imports more from config than the two knobs this
// suite steers, and a full mock breaks the moment it imports one more.
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  getAgentId: () => undefined,
  isAgentScopeIsolated: () => false,
}));

import { registerRememberFunction } from "../src/functions/remember.js";
import { registerSearchFunction, getSearchIndex } from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

function makeMockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function makeMockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : (idOrInput as { payload: unknown }).payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function registered: ${id}`);
      return fn(payload);
    },
  };
}

async function seedSessions(kv: ReturnType<typeof makeMockKV>) {
  const apiSession: Session = {
    id: "sess-api",
    project: "api",
    cwd: "/srv/api",
    startedAt: new Date().toISOString(),
    status: "active",
    observationCount: 0,
  };
  const webSession: Session = {
    id: "sess-web",
    project: "web",
    cwd: "/srv/web",
    startedAt: new Date().toISOString(),
    status: "active",
    observationCount: 0,
  };
  await kv.set(KV.sessions, apiSession.id, apiSession);
  await kv.set(KV.sessions, webSession.id, webSession);
}

describe("cross-project isolation — end-to-end", () => {
  let sdk: ReturnType<typeof makeMockSdk>;
  let kv: ReturnType<typeof makeMockKV>;

  beforeEach(async () => {
    sdk = makeMockSdk();
    kv = makeMockKV();

    // Disable index persistence in tests so no file I/O occurs.

    // Clear the singleton BM25 index between tests.
    getSearchIndex().clear();

    // Register both functions against the shared KV.
    registerRememberFunction(sdk as never, kv as never);
    registerSearchFunction(sdk as never, kv as never);

    await seedSessions(kv);
  });

  it("bug memory scoped to api is excluded from search results for web project", async () => {
    await sdk.trigger("mem::remember", {
      content: "express-jwt throws 401 when Authorization header has extra whitespace",
      type: "bug",
      files: ["src/middleware/auth.ts"],
      project: "api",
    });

    // Force index rebuild so the freshly saved memory is indexed.
    getSearchIndex().clear();

    const result = await sdk.trigger("mem::search", {
      query: "express-jwt whitespace",
      project: "web",
    }) as { results: Array<{ observation: { title: string; narrative?: string } }> };

    const titles = result.results.map((r) => r.observation.title);
    expect(titles.join(" ")).not.toContain("express-jwt");
  });

  it("bug memory scoped to api is included in search results for api project", async () => {
    await sdk.trigger("mem::remember", {
      content: "express-jwt throws 401 when Authorization header has extra whitespace",
      type: "bug",
      files: ["src/middleware/auth.ts"],
      project: "api",
    });

    // Force index rebuild so the freshly saved memory is indexed.
    getSearchIndex().clear();

    const result = await sdk.trigger("mem::search", {
      query: "express-jwt whitespace",
      project: "api",
    }) as { results: Array<{ observation: { title: string; narrative?: string } }> };

    const combined = result.results
      .map((r) => `${r.observation.title} ${r.observation.narrative ?? ""}`)
      .join(" ");
    expect(combined).toContain("express-jwt");
  });

  it("memories from different projects do not supersede each other via Jaccard dedup", async () => {
    const sharedContent = "jwt token must be trimmed before validation in the middleware layer";

    await sdk.trigger("mem::remember", {
      content: sharedContent,
      type: "bug",
      files: ["src/middleware/auth.ts"],
      project: "api",
    });

    // Save nearly identical content under a different project.
    const result = await sdk.trigger("mem::remember", {
      content: sharedContent,
      type: "bug",
      files: ["src/middleware/auth.ts"],
      project: "web",
    }) as { memory: { id: string; project: string } };

    // Both memories must survive as independent latest entries.
    const memories = await kv.list(KV.memories) as Array<{ isLatest: boolean; project: string }>;
    const latestByProject = memories.filter((m) => m.isLatest);
    const projects = latestByProject.map((m) => m.project);

    expect(projects).toContain("api");
    expect(projects).toContain("web");
    expect(result.memory.project).toBe("web");
  });
});
