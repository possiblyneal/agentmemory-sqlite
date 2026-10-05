import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSnapshotFunction } from "../src/functions/snapshot.js";
import { loadSnapshotConfig, __resetEnvFileCache } from "../src/config.js";

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
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      functions.set(typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id, handler);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload: unknown }) => {
      const fn = functions.get(input.function_id);
      if (!fn) throw new Error(`No function: ${input.function_id}`);
      return fn(input.payload);
    },
  };
}

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();

describe("snapshot history pruning", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "am-snapprune-"));
    dir = join(root, "snaps");
    mkdirSync(dir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function run(keep: number, count: number) {
    const sdk = mockSdk();
    const kv = mockKV();
    registerSnapshotFunction(sdk as never, kv as never, dir, keep);
    const results: any[] = [];
    for (let i = 0; i < count; i++) {
      await kv.set("mem:sessions", `s${i}`, {
        id: `s${i}`,
        project: "p",
        cwd: "/x",
        startedAt: "2026-01-01T00:00:00Z",
        status: "completed",
        observationCount: 0,
      });
      results.push(
        await sdk.trigger({
          function_id: "mem::snapshot-create",
          payload: { message: `snap ${i}` },
        }),
      );
    }
    return { sdk, results };
  }

  it("keeps only the newest SNAPSHOT_KEEP commits and still restores them", async () => {
    const { sdk, results } = await run(3, 6);
    expect(results.every((r) => r.success)).toBe(true);

    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("3");
    expect(git(dir, "log", "--format=%s")).toBe("snap 5\nsnap 4\nsnap 3");
    expect(git(dir, "rev-list", "--max-parents=0", "HEAD").split("\n")).toHaveLength(1);
    expect(git(dir, "reflog", "--all")).not.toContain("snap 0");

    const last = results[5].snapshot.commitHash;
    expect(last).toBe(git(dir, "rev-parse", "HEAD"));

    const { snapshots } = (await sdk.trigger({
      function_id: "mem::snapshot-list",
      payload: {},
    })) as { snapshots: { commitHash: string }[] };
    const oldestKept = snapshots[snapshots.length - 1]!.commitHash;
    const restored = (await sdk.trigger({
      function_id: "mem::snapshot-restore",
      payload: { commitHash: oldestKept },
    })) as { success: boolean };
    expect(restored.success).toBe(true);
  });

  it("keeps everything when keep is 0", async () => {
    await run(0, 4);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("4");
  });

  it("leaves history alone while under the limit", async () => {
    await run(10, 4);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("4");
  });
});

describe("loadSnapshotConfig keep", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env["SNAPSHOT_KEEP"];
    __resetEnvFileCache();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env["SNAPSHOT_KEEP"];
    else process.env["SNAPSHOT_KEEP"] = saved;
    __resetEnvFileCache();
  });

  it("defaults to 48, accepts 0, rejects negatives", () => {
    delete process.env["SNAPSHOT_KEEP"];
    expect(loadSnapshotConfig().keep).toBe(48);
    process.env["SNAPSHOT_KEEP"] = "0";
    expect(loadSnapshotConfig().keep).toBe(0);
    process.env["SNAPSHOT_KEEP"] = "-3";
    expect(loadSnapshotConfig().keep).toBe(48);
    process.env["SNAPSHOT_KEEP"] = "7";
    expect(loadSnapshotConfig().keep).toBe(7);
  });
});
