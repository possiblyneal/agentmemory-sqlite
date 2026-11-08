import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastAgentReply } from "../src/hooks/_last-reply.js";
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
    expect(await lastAgentReply(path)).toBe("The token is unset in src/auth.rs.\n\nShall I set it?");
  });

  it("keeps only the reply's last 1000 chars and reads nothing past an earlier prompt", async () => {
    const long = `${"x".repeat(1200)}end`;
    const path = transcript(assistant(text("older reply")), user("next"), assistant(text(long)), user("ok"));
    expect(await lastAgentReply(path)).toBe(long.slice(-1000));
  });

  it("returns empty when the Agent's turn ended on a tool result", async () => {
    const path = transcript(user([{ type: "tool_result", tool_use_id: "t1", content: "..." }]), user("go"));
    expect(await lastAgentReply(path)).toBe("");
  });

  it("rejects when the transcript cannot be read", async () => {
    await expect(lastAgentReply(join(dir, "missing.jsonl"))).rejects.toThrow();
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
