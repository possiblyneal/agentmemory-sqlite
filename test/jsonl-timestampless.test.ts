import { describe, it, expect } from "vitest";
import { parseJsonlText } from "../src/replay/jsonl-parser.js";

const turn = (type: "user" | "assistant", ts: string, text: string) =>
  JSON.stringify({
    type,
    sessionId: "ses-ts",
    timestamp: ts,
    cwd: "/nonexistent/repo",
    message: { role: type, content: [{ type: "text", text }] },
  });

describe("import-jsonl session times", () => {
  const text = [
    JSON.stringify({ type: "file-history-snapshot", messageId: "m1" }),
    turn("user", "2026-04-17T10:00:00.000Z", "hello there friend"),
    turn("assistant", "2026-04-17T10:00:05.000Z", "answer text"),
    JSON.stringify({ type: "last-prompt", lastPrompt: "hello" }),
  ].join("\n");

  it("takes startedAt and endedAt only from entries that carry a timestamp", () => {
    const parsed = parseJsonlText(text);
    expect(parsed.startedAt).toBe("2026-04-17T10:00:00.000Z");
    expect(parsed.endedAt).toBe("2026-04-17T10:00:05.000Z");
  });

  it("dates leading undated Observations from the first timestamp", () => {
    const parsed = parseJsonlText([turn("user", "", "leading prompt"), text].join("\n"));
    expect(parsed.observations[0]?.timestamp).toBe(parsed.startedAt);
  });

  it("dates a timestampless entry's Observation from the last timestamp seen, not the import time", () => {
    const withToolResult = [
      turn("user", "2026-04-17T10:00:00.000Z", "run it please"),
      JSON.stringify({
        type: "user",
        sessionId: "ses-ts",
        cwd: "/nonexistent/repo",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      }),
    ].join("\n");
    const parsed = parseJsonlText(withToolResult);
    expect(parsed.observations.map((o) => o.timestamp)).toEqual([
      "2026-04-17T10:00:00.000Z",
      "2026-04-17T10:00:00.000Z",
    ]);
  });
});
