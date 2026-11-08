import { open } from "node:fs/promises";
import { MAX_REPLY_QUERY_CHARS } from "../utils/terse-prompt.js";

const TAIL_BYTES = 256 * 1024;

interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  message?: { content?: unknown };
}

function blocks(entry: TranscriptEntry): Array<{ type?: string; text?: string }> {
  const content = entry.message?.content;
  return Array.isArray(content) ? content : [];
}

// The text the Agent wrote after its last tool result, read from the end of
// the Claude Code transcript: what a terse prompt such as "go ahead" answers.
// Returns its last MAX_REPLY_QUERY_CHARS, or "" when there is none to read.
export async function lastAgentReply(transcriptPath: string): Promise<string> {
  const file = await open(transcriptPath, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(TAIL_BYTES, size);
    const { buffer } = await file.read(Buffer.alloc(length), 0, length, size - length);
    const reply: string[] = [];
    for (const line of buffer.toString("utf8").split("\n").reverse()) {
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.isSidechain) continue;
      if (entry.type === "user") {
        if (reply.length > 0 || blocks(entry).some((b) => b.type === "tool_result")) break;
      } else if (entry.type === "assistant") {
        const texts = blocks(entry).flatMap((b) => (b.type === "text" && b.text ? [b.text] : []));
        reply.unshift(...texts);
      }
    }
    return reply.join("\n\n").trim().slice(-MAX_REPLY_QUERY_CHARS);
  } finally {
    await file.close();
  }
}
