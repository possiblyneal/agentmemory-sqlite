import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";

const STOP_HOOK = join(import.meta.dirname, "..", "plugin", "scripts", "stop.mjs");

interface Seen {
  url: string;
  body: Record<string, unknown>;
}

describe("stop hook — the turn-ending reply", () => {
  let server: Server;
  let url = "";
  let seen: Seen[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", body: JSON.parse(raw || "{}") });
        res.setHeader("Content-Type", "application/json");
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  function runStop(stdin: object): Promise<number | null> {
    seen = [];
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [STOP_HOOK], {
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"], AGENTMEMORY_URL: url },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("close", resolve);
      child.stdin.end(JSON.stringify(stdin));
    });
  }

  it("posts the reply as a stop Observation, capped at 4,000 chars, besides ending the turn", async () => {
    const code = await runStop({
      session_id: "ses_stop",
      cwd: "/tmp/fake-project",
      last_assistant_message: "r".repeat(5000),
    });
    expect(code).toBe(0);

    const observe = seen.find((s) => s.url === "/agentmemory/observe");
    expect(observe?.body["hookType"]).toBe("stop");
    expect(observe?.body["sessionId"]).toBe("ses_stop");
    expect(observe?.body["data"]).toEqual({ last_message: "r".repeat(4000) });
    expect(seen.find((s) => s.url === "/agentmemory/session/end")?.body).toEqual({
      sessionId: "ses_stop",
      turnEnd: true,
    });
  });

  it("posts no Observation when the turn ended without a reply", async () => {
    await runStop({ session_id: "ses_stop", cwd: "/tmp/fake-project" });
    expect(seen.map((s) => s.url)).toEqual(["/agentmemory/session/end"]);
  });
});
