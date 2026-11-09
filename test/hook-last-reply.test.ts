import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastAgentReply, withinDeadline } from "../src/hooks/_last-reply.js";
import { isTersePrompt } from "../src/utils/terse-prompt.js";

const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
const assistant = (...content: unknown[]) => ({ type: "assistant", message: { role: "assistant", content } });
const text = (t: string) => ({ type: "text", text: t });

describe("lastAgentReply", () => {
  let dir: string;
  const transcript = (...entries: unknown[]) => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "amem-reply-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the text the Agent wrote after its last tool result, skipping the prompt just typed", async () => {
    const path = transcript(
      user("fix the deploy"),
      assistant(text("Looking."), { type: "tool_use", id: "t1", name: "Read", input: {} }),
      user([{ type: "tool_result", tool_use_id: "t1", content: "..." }]),
      assistant({ type: "thinking", thinking: "hm" }, text("The token is unset in src/auth.rs.")),
      { type: "assistant", isSidechain: true, message: { content: [text("subagent chatter")] } },
      assistant(text("Shall I set it?")),
      user("yes"),
    );
    expect(await lastAgentReply(path, "yes")).toBe("The token is unset in src/auth.rs.\n\nShall I set it?");
  });

  it("keeps only the reply's last 1000 chars and reads nothing past an earlier prompt", async () => {
    const long = `${"x".repeat(1200)}end`;
    const path = transcript(assistant(text("older reply")), user("next"), assistant(text(long)), user("ok"));
    expect(await lastAgentReply(path, "ok")).toBe(long.slice(-1000));
  });

  it("returns empty when the Agent's turn ended on a tool result", async () => {
    const path = transcript(user([{ type: "tool_result", tool_use_id: "t1", content: "..." }]), user("go"));
    expect(await lastAgentReply(path, "go")).toBe("");
  });

  it("returns empty when the Operator's last turn was interrupted before any reply", async () => {
    const written = transcript(
      assistant(text("Shall I deploy staging?")),
      user("rename the cart module"),
      user([text("[Request interrupted by user]")]),
      user("go"),
    );
    expect(await lastAgentReply(written, "go")).toBe("");
    const notYetWritten = transcript(
      assistant(text("Shall I deploy staging?")),
      user("rename the cart module"),
      user([text("[Request interrupted by user]")]),
    );
    expect(await lastAgentReply(notYetWritten, "go")).toBe("");
  });

  it("reads past harness messages and slash-command wrappers", async () => {
    const path = transcript(
      assistant(text("Shall I set it?")),
      user("<task-notification><task-id>a</task-id></task-notification>"),
      user("<command-name>/ship</command-name>"),
      user("yes"),
    );
    expect(await lastAgentReply(path, "yes")).toBe("Shall I set it?");
  });

  it("rejects when the transcript cannot be read", async () => {
    await expect(lastAgentReply(join(dir, "missing.jsonl"), "go")).rejects.toThrow();
  });
});

describe("withinDeadline", () => {
  it("falls back to empty when the read outlasts its deadline or fails", async () => {
    expect(await withinDeadline(new Promise<string>(() => {}), 10)).toBe("");
    expect(await withinDeadline(Promise.reject(new Error("EIO")), 10)).toBe("");
    expect(await withinDeadline(Promise.resolve("reply"), 10)).toBe("reply");
  });
});

describe("isTersePrompt", () => {
  it("is true below three content words", () => {
    expect(isTersePrompt("yes, go ahead")).toBe(true);
    expect(isTersePrompt("2")).toBe(true);
    expect(isTersePrompt("please make the change now")).toBe(true);
    expect(isTersePrompt("retry the staging deploy token")).toBe(false);
  });
});
