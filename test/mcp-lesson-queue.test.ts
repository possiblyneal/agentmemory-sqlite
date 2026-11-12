import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleToolCall } from "../src/mcp/standalone.js";
import { resetHandleForTests } from "../src/mcp/rest-proxy.js";
import { lessonQueueDir } from "../src/mcp/lesson-queue.js";

process.env["AGENTMEMORY_PROJECT_NAME"] = "cwd-project";

type Handler = (url: string, init?: RequestInit) => Response;

function installFetch(handler: Handler): void {
  (globalThis as { fetch: typeof fetch }).fetch = vi.fn(
    async (url: string | URL, init?: RequestInit) => handler(url.toString(), init),
  ) as unknown as typeof fetch;
}

function daemonDown(): void {
  installFetch(() => {
    throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:3111");
  });
}

function daemonUp(onSave: (args: Record<string, unknown>) => Response): void {
  installFetch((url, init) => {
    if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
    const body = JSON.parse((init?.body as string) || "{}");
    if (body.name === "memory_lesson_save") return onSave(body.arguments);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 });
  });
}

function saved(): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 });
}

function queued(): string[] {
  try {
    return readdirSync(lessonQueueDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
}

describe("memory_lesson_save queue when the daemon is unreachable (#389)", () => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env["HOME"];
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lesson-queue-"));
    process.env["HOME"] = home;
    resetHandleForTests();
    delete process.env["AGENTMEMORY_URL"];
    delete process.env["AGENTMEMORY_FORCE_PROXY"];
  });

  afterEach(() => {
    resetHandleForTests();
    globalThis.fetch = originalFetch;
    process.env["HOME"] = originalHome;
    delete process.env["AGENTMEMORY_URL"];
    delete process.env["AGENTMEMORY_FORCE_PROXY"];
    rmSync(home, { recursive: true, force: true });
  });

  it("queues a save when no daemon answers the probe and says so", async () => {
    daemonDown();
    const res = await handleToolCall("memory_lesson_save", { content: "pin lockfiles" });
    expect(JSON.parse(res.content[0].text).queued).toBe(true);
    expect(queued()).toHaveLength(1);
  });

  it("queues a save whose call fails with a connection error after the probe passed", async () => {
    process.env["AGENTMEMORY_FORCE_PROXY"] = "1";
    daemonDown();
    const res = await handleToolCall("memory_lesson_save", { content: "pin lockfiles" });
    expect(JSON.parse(res.content[0].text).queued).toBe(true);
    expect(queued()).toHaveLength(1);
  });

  it("queues a save when an explicitly named daemon is unreachable", async () => {
    process.env["AGENTMEMORY_URL"] = "http://localhost:3999";
    daemonDown();
    const res = await handleToolCall("memory_lesson_save", { content: "pin lockfiles" });
    expect(JSON.parse(res.content[0].text).queued).toBe(true);
    expect(queued()).toHaveLength(1);
  });

  it("refuses to queue a save with no content", async () => {
    daemonDown();
    await expect(handleToolCall("memory_lesson_save", { content: " " })).rejects.toThrow(
      "content is required",
    );
    expect(queued()).toHaveLength(0);
  });

  it("replays queued saves in order on the next call that reaches the daemon", async () => {
    daemonDown();
    await handleToolCall("memory_lesson_save", { content: "first" });
    await handleToolCall("memory_lesson_save", { content: "second" });

    resetHandleForTests();
    const replayed: Array<Record<string, unknown>> = [];
    daemonUp((args) => {
      replayed.push(args);
      return saved();
    });
    await handleToolCall("memory_lesson_recall", { query: "lockfiles" });

    expect(replayed.map((a) => a["content"])).toEqual(["first", "second"]);
    expect(replayed[0]["project"]).toBe("cwd-project");
    expect(queued()).toHaveLength(0);
  });

  it("drops a queued save the daemon rejects with 4xx and replays the rest", async () => {
    daemonDown();
    await handleToolCall("memory_lesson_save", { content: "refused" });
    await handleToolCall("memory_lesson_save", { content: "accepted" });

    resetHandleForTests();
    const attempts: string[] = [];
    daemonUp((args) => {
      attempts.push(String(args["content"]));
      return args["content"] === "refused"
        ? new Response(JSON.stringify({ error: "Unknown project" }), { status: 400 })
        : saved();
    });
    await handleToolCall("memory_lesson_recall", { query: "x" });
    await handleToolCall("memory_lesson_recall", { query: "x" });

    expect(attempts).toEqual(["refused", "accepted"]);
    expect(queued()).toHaveLength(0);
  });

  it("keeps a queued save the daemon cannot take yet", async () => {
    daemonDown();
    await handleToolCall("memory_lesson_save", { content: "later" });

    resetHandleForTests();
    daemonUp(() => new Response("not ready", { status: 503 }));
    await handleToolCall("memory_lesson_recall", { query: "x" });
    expect(queued()).toHaveLength(1);

    const replayed: string[] = [];
    daemonUp((args) => {
      replayed.push(String(args["content"]));
      return saved();
    });
    await handleToolCall("memory_lesson_recall", { query: "x" });
    expect(replayed).toEqual(["later"]);
    expect(queued()).toHaveLength(0);
  });
});
