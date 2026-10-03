import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
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
  const compactPayload = () => JSON.stringify({ session_id: "ses_test", cwd: home });

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
    const result = await runHook("pre-compact.mjs", compactPayload(), { HOME: home });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    const [entry, ...rest] = records();
    expect(rest).toEqual([]);
    expect(entry.hook).toBe("pre-compact");
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
    const result = await runHook("pre-compact.mjs", compactPayload(), {
      HOME: home,
      AGENTMEMORY_URL: url,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(recordPath())).toBe(false);
  });

  it("truncates the record to its newest entries past the size cap", async () => {
    mkdirSync(join(home, ".agentmemory"));
    const old = JSON.stringify({ at: "2026-01-01T00:00:00.000Z", hook: "session-start", reason: "timeout", pad: "x".repeat(200) });
    writeFileSync(recordPath(), `${old}\n`.repeat(2000));
    await runHook("pre-compact.mjs", compactPayload(), { HOME: home });
    const kept = records();
    expect(kept.length).toBe(1000);
    expect(kept.at(-1)?.hook).toBe("pre-compact");
  });

  it("still exits 0 when the home directory is unwritable", async () => {
    const fileAsHome = join(home, "not-a-dir");
    writeFileSync(fileAsHome, "");
    const result = await runHook("pre-compact.mjs", compactPayload(), { HOME: fileAsHome });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("prompt-submit hook — per-prompt Injection (#106)", () => {
  let server: Server;
  let url = "";
  let requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let home = "";
  const prompt = {
    hook_event_name: "UserPromptSubmit",
    session_id: "ses_test",
    cwd: "/work/shipctl",
    prompt: "staging auth fails when SHIPCTL_TOKEN is unset",
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ path: req.url ?? "", body: JSON.parse(body || "{}") });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(req.url === "/agentmemory/prompt-context" ? { context: "remembered auth fix" } : {}));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  beforeEach(() => {
    requests = [];
    home = mkdtempSync(join(tmpdir(), "prompt-submit-home-"));
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("records the prompt but injects nothing when AGENTMEMORY_INJECT_CONTEXT is unset", async () => {
    const result = await runHook("prompt-submit.mjs", JSON.stringify(prompt), { HOME: home, AGENTMEMORY_URL: url });
    expect(result.stdout).toBe("");
    expect(requests.map((r) => r.path)).toEqual(["/agentmemory/observe"]);
  });

  it("injects recalled context in the UserPromptSubmit envelope", async () => {
    const result = await runHook("prompt-submit.mjs", JSON.stringify(prompt), {
      HOME: home,
      AGENTMEMORY_URL: url,
      AGENTMEMORY_INJECT_CONTEXT: "true",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "remembered auth fix" },
    });
    const ask = requests.find((r) => r.path === "/agentmemory/prompt-context");
    expect(ask?.body).toEqual({ sessionId: "ses_test", project: "shipctl", prompt: prompt.prompt });
    expect(requests.some((r) => r.path === "/agentmemory/observe")).toBe(true);
  });

  it("does not inject into a subagent", async () => {
    const result = await runHook("prompt-submit.mjs", JSON.stringify({ ...prompt, agent_id: "agent_1" }), {
      HOME: home,
      AGENTMEMORY_URL: url,
      AGENTMEMORY_INJECT_CONTEXT: "true",
    });
    expect(result.stdout).toBe("");
    expect(requests.some((r) => r.path === "/agentmemory/prompt-context")).toBe(false);
  });

  it("does not inject for a host that sends no UserPromptSubmit event name", async () => {
    const { hook_event_name: _, ...bare } = prompt;
    const result = await runHook("prompt-submit.mjs", JSON.stringify(bare), {
      HOME: home,
      AGENTMEMORY_URL: url,
      AGENTMEMORY_INJECT_CONTEXT: "true",
    });
    expect(result.stdout).toBe("");
  });

  it("records a Missed Injection when the daemon is down", async () => {
    const result = await runHook("prompt-submit.mjs", JSON.stringify(prompt), {
      HOME: home,
      AGENTMEMORY_URL: "http://127.0.0.1:1",
      AGENTMEMORY_INJECT_CONTEXT: "true",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    const entry = JSON.parse(readFileSync(join(home, ".agentmemory", "missed-injections.jsonl"), "utf-8").trim());
    expect([entry.hook, entry.reason]).toEqual(["prompt-submit", "connection"]);
  });
});
