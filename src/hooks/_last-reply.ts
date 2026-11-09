import { open } from "node:fs/promises";
import { isHarnessMessage } from "../utils/harness-message.js";
import { isOperatorTurn } from "../utils/operator-turn.js";
import { MAX_REPLY_QUERY_CHARS } from "../utils/terse-prompt.js";

const TAIL_BYTES = 256 * 1024;

interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
}

function blocks(entry: TranscriptEntry): Array<{ type?: string; text?: string }> {
  const content = entry.message?.content;
  return Array.isArray(content) ? content : [];
}

function typedText(entry: TranscriptEntry): string | undefined {
  const content = entry.message?.content;
  if (typeof content !== "string" || entry.isMeta || entry.isCompactSummary) return undefined;
  const text = content.trim();
  return isOperatorTurn(text) && !isHarnessMessage(text) ? text : undefined;
}

// A terse prompt such as "go ahead" answers this reply. Past an earlier typed
// prompt there is nothing it answers, as in the replay eval that measured it.
export async function lastAgentReply(transcriptPath: string, prompt: string): Promise<string> {
  const file = await open(transcriptPath, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(TAIL_BYTES, size);
    const { buffer } = await file.read(Buffer.alloc(length), 0, length, size - length);
    const reply: string[] = [];
    let passedCurrent = false;
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
        const typed = typedText(entry);
        if (typed === undefined) continue;
        if (passedCurrent || typed !== prompt.trim()) break;
        passedCurrent = true;
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

// The transcript read must never hold the hook past its Injection budget.
export function withinDeadline(read: Promise<string>, ms: number): Promise<string> {
  return Promise.race([
    read.catch(() => ""),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), ms).unref()),
  ]);
}
