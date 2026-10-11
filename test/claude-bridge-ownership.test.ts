import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerClaudeBridgeFunction } from "../src/functions/claude-bridge.js";
import { logger } from "../src/logger.js";
import type { ClaudeBridgeConfig, Memory } from "../src/types.js";

function mockKV() {
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
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => void functions.set(id, handler),
    registerTrigger: () => {},
    trigger: async (id: string, data?: unknown) => functions.get(id)!(data),
  };
}

function memory(id: string, title: string, project?: string): Memory {
  return {
    id,
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    type: "fact",
    title,
    content: `${title} body`,
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 5,
    version: 1,
    isLatest: true,
    ...(project && { project }),
  };
}

type SyncResult = { success: boolean; error?: string };

describe("Claude bridge sync ownership and project scope", () => {
  let dir: string;
  let target: string;
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    mkdirSync("tmp", { recursive: true });
    dir = mkdtempSync(join("tmp", "bridge-"));
    target = join(dir, "memory", "MEMORY.md");
    process.env["AGENTMEMORY_PROJECT_NAME"] = "proj-a";
    const config: ClaudeBridgeConfig = {
      enabled: true,
      projectPath: dir,
      memoryFilePath: target,
      lineBudget: 200,
    };
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerClaudeBridgeFunction(sdk as never, kv as never, config);
  });

  afterEach(() => {
    delete process.env["AGENTMEMORY_PROJECT_NAME"];
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a hand-written MEMORY.md byte-identical and says why", async () => {
    mkdirSync(join(dir, "memory"), { recursive: true });
    const handWritten = "# My notes\n\nDo not touch.\n";
    writeFileSync(target, handWritten);
    await kv.set("mem:memories", "m1", memory("m1", "Mine", "proj-a"));

    const result = (await sdk.trigger("mem::claude-bridge-sync", {})) as SyncResult;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not written by agentmemory/i);
    expect(readFileSync(target, "utf-8")).toBe(handWritten);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("writes a missing file and rewrites one the bridge wrote earlier", async () => {
    await kv.set("mem:memories", "m1", memory("m1", "First", "proj-a"));
    expect(existsSync(target)).toBe(false);

    expect(((await sdk.trigger("mem::claude-bridge-sync", {})) as SyncResult).success).toBe(true);
    expect(readFileSync(target, "utf-8")).toContain("First");

    await kv.set("mem:memories", "m2", memory("m2", "Second", "proj-a"));
    expect(((await sdk.trigger("mem::claude-bridge-sync", {})) as SyncResult).success).toBe(true);
    expect(readFileSync(target, "utf-8")).toContain("Second");
  });

  it("never writes Memories from another project", async () => {
    await kv.set("mem:memories", "m1", memory("m1", "Ours", "proj-a"));
    await kv.set("mem:memories", "m2", memory("m2", "Theirs", "proj-b"));
    await kv.set("mem:memories", "m3", memory("m3", "Unscoped"));

    await sdk.trigger("mem::claude-bridge-sync", {});

    const written = readFileSync(target, "utf-8");
    expect(written).toContain("Ours");
    expect(written).not.toContain("Theirs");
    expect(written).not.toContain("Unscoped");
  });
});
