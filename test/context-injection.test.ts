import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS_DIR = join(import.meta.dirname, "..", "plugin", "scripts");

// Spawns a compiled plugin hook as a subprocess, feeds it JSON on stdin,
// and returns { stdout, stderr, exitCode, tookMs }. The test is about
// making sure the hook writes NOTHING to stdout when context injection is
// disabled — which is what Claude Code reads to decide whether to prepend
// memory context to the next tool turn.
function runHook(
  scriptName: string,
  stdin: string,
  env: Record<string, string>,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  tookMs: number;
}> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(
      process.execPath,
      [join(HOOKS_DIR, scriptName)],
      {
        env: {
          // Start from a clean slate — don't leak test-runner env into
          // the hook. Only pass PATH, the sandbox below, and anything
          // explicitly set by the test case.
          PATH: process.env["PATH"] ?? "",
          // Hooks read ~/.agentmemory/.env; vitest.config's throwaway HOME keeps
          // the Operator's file out, and a dead URL keeps the live daemon out.
          HOME: process.env["HOME"],
          AGENTMEMORY_URL: "http://127.0.0.1:1",
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode, tookMs: Date.now() - start });
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe("pre-tool-use hook — context injection gate (#143)", () => {
  it("writes nothing to stdout when AGENTMEMORY_INJECT_CONTEXT is unset (default)", async () => {
    const payload = JSON.stringify({
      session_id: "ses_test",
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
    });
    // No AGENTMEMORY_* env vars at all — simulates a fresh Claude Pro
    // install with no ~/.agentmemory/.env overrides.
    const result = await runHook("pre-tool-use.mjs", payload, {});
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("writes nothing to stdout when AGENTMEMORY_INJECT_CONTEXT=false explicitly", async () => {
    const payload = JSON.stringify({
      session_id: "ses_test",
      tool_name: "Edit",
      tool_input: { file_path: "src/foo.ts", old_string: "a", new_string: "b" },
    });
    const result = await runHook("pre-tool-use.mjs", payload, {
      AGENTMEMORY_INJECT_CONTEXT: "false",
    });
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("exits fast when disabled (no stdin consumption, no network fetch)", async () => {
    // The disabled path must not open stdin or reach for fetch — it
    // should return immediately. A 250ms budget is generous enough to
    // account for Node startup on CI while still catching any accidental
    // fetch round-trip or stdin buffering.
    const result = await runHook("pre-tool-use.mjs", "", {});
    expect(result.tookMs).toBeLessThan(1000);
    expect(result.stdout).toBe("");
  });

  it("when AGENTMEMORY_INJECT_CONTEXT=true, hook still runs but safely errors on unreachable backend", async () => {
    // Opt-in path. We point at a port that's guaranteed closed so the
    // fetch fails fast; the hook must still exit cleanly (the whole
    // point of the try/catch is not to break Claude Code) and must not
    // echo anything to stdout when the fetch fails.
    const payload = JSON.stringify({
      session_id: "ses_test",
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
    });
    const result = await runHook("pre-tool-use.mjs", payload, {
      AGENTMEMORY_INJECT_CONTEXT: "true",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("pre-tool-use hook — context envelope (#1278)", () => {
  let server: Server;
  let url = "";

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ context: "remembered about foo.ts" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("wraps context in the hookSpecificOutput envelope for Claude Code", async () => {
    const payload = JSON.stringify({
      session_id: "ses_test",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
    });
    const result = await runHook("pre-tool-use.mjs", payload, {
      AGENTMEMORY_INJECT_CONTEXT: "true",
      AGENTMEMORY_URL: url,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "remembered about foo.ts",
      },
    });
  });

  it("keeps plain text for hosts that send no hook_event_name", async () => {
    const payload = JSON.stringify({
      conversation_id: "ses_test",
      toolName: "read",
      toolArgs: { path: "src/foo.ts" },
    });
    const result = await runHook("pre-tool-use.mjs", payload, {
      AGENTMEMORY_INJECT_CONTEXT: "true",
      AGENTMEMORY_URL: url,
    });
    expect(result.stdout).toBe("remembered about foo.ts");
  });
});

describe("pre-tool-use hook — project scope (#71)", () => {
  let server: Server;
  let url = "";
  let tmpRoot = "";
  let repoDir = "";
  const bodies: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "amem-ptu-"));
    repoDir = join(tmpRoot, "scoped-fixture");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: repoDir, stdio: "ignore" });
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ context: "" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    rmSync(tmpRoot, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("scopes enrich to the project of the hook's cwd", async () => {
    bodies.length = 0;
    const payload = JSON.stringify({
      session_id: "ses_test",
      hook_event_name: "PreToolUse",
      cwd: join(repoDir, "src"),
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
    });
    await runHook("pre-tool-use.mjs", payload, {
      AGENTMEMORY_INJECT_CONTEXT: "true",
      AGENTMEMORY_URL: url,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].project).toBe("scoped-fixture");
  });

  it("lets an explicit project in the payload win", async () => {
    bodies.length = 0;
    const payload = JSON.stringify({
      session_id: "ses_test",
      cwd: repoDir,
      project: "named-project",
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
    });
    await runHook("pre-tool-use.mjs", payload, {
      AGENTMEMORY_INJECT_CONTEXT: "true",
      AGENTMEMORY_URL: url,
    });
    expect(bodies[0].project).toBe("named-project");
  });

  it("sends no project when the cwd has no name, rather than an empty one /enrich rejects", async () => {
    bodies.length = 0;
    const payload = JSON.stringify({
      session_id: "ses_test",
      cwd: "/",
      tool_name: "Read",
      tool_input: { file_path: "etc/hosts" },
    });
    await runHook("pre-tool-use.mjs", payload, {
      AGENTMEMORY_INJECT_CONTEXT: "true",
      AGENTMEMORY_URL: url,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("project");
  });
});

describe("session-start hook — context injection gate (#143)", () => {
  it("registers the session but writes nothing to stdout when AGENTMEMORY_INJECT_CONTEXT is unset", async () => {
    // Session registration POST will fail against the unreachable URL,
    // but the hook's try/catch must swallow that cleanly — Claude Code
    // must never see an error at session start.
    const payload = JSON.stringify({
      session_id: "ses_test",
      cwd: "/tmp/fake-project",
    });
    const result = await runHook("session-start.mjs", payload, {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("neither registers nor injects when the SessionStart fires inside a subagent", async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? "");
      req.resume();
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ context: "project history" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    try {
      const env = { AGENTMEMORY_INJECT_CONTEXT: "true", AGENTMEMORY_URL: url };
      const main = { session_id: "ses_test", cwd: "/tmp/fake-project", source: "compact" };
      const subagent = await runHook("session-start.mjs", JSON.stringify({ ...main, agent_id: "a078d460" }), env);
      expect(subagent.stdout).toBe("");
      expect(paths).toHaveLength(0);

      const mainThread = await runHook("session-start.mjs", JSON.stringify(main), env);
      expect(mainThread.stdout).toBe("project history");
      expect(paths).toEqual(["/agentmemory/session/start"]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("context-injecting hooks — Missed Injection record (#73)", () => {
  let server: Server;
  let url = "";
  let reply: (res: import("node:http").ServerResponse) => void = () => {};
  let home = "";
  const recordPath = () => join(home, ".agentmemory", "missed-injections.jsonl");
  const records = () =>
    readFileSync(recordPath(), "utf-8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { at: string; hook: string; reason: string });
  const readPayload = JSON.stringify({
    session_id: "ses_test",
    tool_name: "Read",
    tool_input: { file_path: "src/foo.ts" },
  });

  beforeAll(async () => {
    server = createServer((_req, res) => reply(res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "missed-injection-home-"));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("records a connection error without writing stdout", async () => {
    const result = await runHook("pre-tool-use.mjs", readPayload, {
      HOME: home,
      AGENTMEMORY_INJECT_CONTEXT: "true",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    const [entry, ...rest] = records();
    expect(rest).toEqual([]);
    expect(entry.hook).toBe("pre-tool-use");
    expect(entry.reason).toBe("connection");
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
  });

  it("records a non-2xx reply by its status", async () => {
    reply = (res) => {
      res.statusCode = 500;
      res.end("{}");
    };
    const result = await runHook(
      "pre-compact.mjs",
      JSON.stringify({ session_id: "ses_test", cwd: home }),
      { HOME: home, AGENTMEMORY_URL: url },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(records().map((r) => [r.hook, r.reason])).toEqual([["pre-compact", "http_500"]]);
  });

  it("records a reply slower than the hook timeout as a timeout", async () => {
    reply = () => {};
    const result = await runHook(
      "session-start.mjs",
      JSON.stringify({ session_id: "ses_test", cwd: home }),
      { HOME: home, AGENTMEMORY_URL: url, AGENTMEMORY_INJECT_CONTEXT: "true" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(records().map((r) => [r.hook, r.reason])).toEqual([["session-start", "timeout"]]);
  });

  it("does not record an empty reply", async () => {
    reply = (res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ context: "" }));
    };
    const result = await runHook("pre-tool-use.mjs", readPayload, {
      HOME: home,
      AGENTMEMORY_URL: url,
      AGENTMEMORY_INJECT_CONTEXT: "true",
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(recordPath())).toBe(false);
  });

  it("truncates the record to its newest entries past the size cap", async () => {
    mkdirSync(join(home, ".agentmemory"));
    const old = JSON.stringify({ at: "2026-01-01T00:00:00.000Z", hook: "pre-compact", reason: "timeout", pad: "x".repeat(200) });
    writeFileSync(recordPath(), `${old}\n`.repeat(2000));
    await runHook("pre-tool-use.mjs", readPayload, {
      HOME: home,
      AGENTMEMORY_INJECT_CONTEXT: "true",
    });
    const kept = records();
    expect(kept.length).toBe(1000);
    expect(kept.at(-1)?.hook).toBe("pre-tool-use");
  });

  it("still exits 0 when the home directory is unwritable", async () => {
    const fileAsHome = join(home, "not-a-dir");
    writeFileSync(fileAsHome, "");
    const result = await runHook("pre-tool-use.mjs", readPayload, {
      HOME: fileAsHome,
      AGENTMEMORY_INJECT_CONTEXT: "true",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});
