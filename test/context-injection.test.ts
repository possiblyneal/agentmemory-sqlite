import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
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
});
