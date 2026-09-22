import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydrateHookEnv, parseEnvFile } from "../src/hooks/_env.js";

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_USERPROFILE = process.env["USERPROFILE"];
const KEYS = ["AGENTMEMORY_INJECT_CONTEXT", "AGENTMEMORY_URL", "AGENTMEMORY_SECRET"] as const;

let sandboxHome: string;

function writeEnv(contents: string) {
  const dir = join(sandboxHome, ".agentmemory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), contents);
}

describe("hydrateHookEnv", () => {
  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-hook-env-"));
    process.env["HOME"] = sandboxHome;
    process.env["USERPROFILE"] = sandboxHome;
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = ORIGINAL_HOME;
    if (ORIGINAL_USERPROFILE === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = ORIGINAL_USERPROFILE;
    for (const key of KEYS) delete process.env[key];
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("copies file values into process.env", () => {
    writeEnv([
      "# comment",
      "AGENTMEMORY_INJECT_CONTEXT=true   # opt in",
      'AGENTMEMORY_URL="http://10.0.0.5:3111"',
      "",
    ].join("\n"));

    hydrateHookEnv();

    expect(process.env["AGENTMEMORY_INJECT_CONTEXT"]).toBe("true");
    expect(process.env["AGENTMEMORY_URL"]).toBe("http://10.0.0.5:3111");
  });

  it("keeps a value already present in process.env", () => {
    process.env["AGENTMEMORY_SECRET"] = "from-shell";
    writeEnv("AGENTMEMORY_SECRET=from-file\n");

    hydrateHookEnv();

    expect(process.env["AGENTMEMORY_SECRET"]).toBe("from-shell");
  });

  it("is a no-op when the file is missing", () => {
    hydrateHookEnv();

    for (const key of KEYS) expect(process.env[key]).toBeUndefined();
  });
});

describe("parseEnvFile", () => {
  it("matches the daemon's parse rules", () => {
    expect(parseEnvFile("A=1\nB='two' # c\nC=three # c\n# D=4\nE\n")).toEqual({
      A: "1",
      B: "two",
      C: "three",
    });
  });
});

describe("hook scripts", () => {
  it("every hook entry hydrates the env before its first AGENTMEMORY_* read", () => {
    const hooksDir = join(__dirname, "..", "src", "hooks");
    const entries = readdirSync(hooksDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_") && f !== "sdk-guard.ts");
    expect(entries).toHaveLength(14);
    for (const entry of entries) {
      const source = readFileSync(join(hooksDir, entry), "utf-8");
      const callAt = source.indexOf("hydrateHookEnv();");
      const firstRead = source.search(/process\.env\[?"?AGENTMEMORY_/);
      expect(callAt, `${entry} must call hydrateHookEnv()`).toBeGreaterThan(-1);
      if (firstRead !== -1) {
        expect(callAt, `${entry} reads env before hydrateHookEnv()`).toBeLessThan(firstRead);
      }
    }
  });
});
