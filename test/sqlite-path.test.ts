import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getSqlitePath, __resetEnvFileCache } from "../src/config.js";
import { SqliteState } from "../src/engine/inproc/state.js";

const KEYS = ["AGENTMEMORY_SQLITE_PATH", "AGENTMEMORY_DATA_DIR", "HOME", "USERPROFILE"];

describe("getSqlitePath", () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    home = mkdtempSync(join(tmpdir(), "am-sqlitepath-"));
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    delete process.env["AGENTMEMORY_SQLITE_PATH"];
    delete process.env["AGENTMEMORY_DATA_DIR"];
    __resetEnvFileCache();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetEnvFileCache();
    rmSync(home, { recursive: true, force: true });
  });

  it("defaults to .agentmemory under the home dir", () => {
    expect(getSqlitePath().endsWith(join(".agentmemory", "agentmemory.sqlite"))).toBe(true);
  });

  it("follows AGENTMEMORY_DATA_DIR", () => {
    process.env["AGENTMEMORY_DATA_DIR"] = join(home, "elsewhere");
    expect(getSqlitePath()).toBe(join(home, "elsewhere", "agentmemory.sqlite"));
  });

  it("lets AGENTMEMORY_SQLITE_PATH win over AGENTMEMORY_DATA_DIR", () => {
    process.env["AGENTMEMORY_DATA_DIR"] = join(home, "elsewhere");
    process.env["AGENTMEMORY_SQLITE_PATH"] = join(home, "exact.sqlite");
    expect(getSqlitePath()).toBe(join(home, "exact.sqlite"));
  });
});

describe("SqliteState parent directory", () => {
  it("creates a missing parent directory", () => {
    const root = mkdtempSync(join(tmpdir(), "am-sqlite-parent-"));
    const path = join(root, "a", "b", "state.sqlite");
    const store = new SqliteState(path);
    store.close();
    expect(existsSync(path)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
