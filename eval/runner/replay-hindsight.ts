import type { ProbeItem } from "./replay-score.js";
import { relativeToCwd } from "./replay-transcript.js";

// What Hindsight's own Claude Code integration (hindsight-integrations/
// claude-code 0.7.6) does with its default settings, with dynamicBankId on so
// each project gets its own bank. It retains on Stop and recalls on
// UserPromptSubmit; its SessionStart hook injects nothing.
export const HINDSIGHT_PLUGIN = {
  version: "0.7.6",
  retainEveryNTurns: 10,
  retainContext: "claude-code",
  recall: { maxTokens: 1024, budget: "mid", types: ["observation"], maxQueryChars: 800, minPromptChars: 5 },
  bankMission:
    "You are a Claude Code AI assistant. Focus on technical discussions, decisions, and context relevant to the user's projects.",
  retainMission:
    "Extract technical decisions, architectural choices, user preferences, project context, and people/tool relationships. Ignore routine greetings and transient operational details.",
  preamble:
    "Relevant memories from past conversations (prioritize recent when conflicting). Only use memories that are directly useful to continue this conversation; ignore the rest:",
} as const;

// dynamicBankGranularity ["agent", "project"] with the default agent name.
export function bankId(project: string): string {
  return `claude-code::${project}`;
}

export function recallQuery(prompt: string): string | null {
  const query = prompt.trim();
  return query.length < HINDSIGHT_PLUGIN.recall.minPromptChars ? null : query.slice(0, HINDSIGHT_PLUGIN.recall.maxQueryChars);
}

interface Message {
  role: string;
  content: unknown;
}

type Entry = Record<string, unknown>;

const OPERATIONAL_TOOL = /(?:recall|retain|reflect|search|extract|create_|delete_|update_|get_|list_)/i;
const MESSAGE_FIELDS = ["text", "body", "message", "content"];

// An MCP reply tool (Telegram, Slack...) carries the Agent's answer to the user.
function channelMessage(block: Entry): string | undefined {
  const name = typeof block.name === "string" ? block.name : "";
  if (!name.startsWith("mcp__") || OPERATIONAL_TOOL.test(name.split("__").pop()!)) return undefined;
  const input = block.input;
  if (!input || typeof input !== "object") return undefined;
  for (const field of MESSAGE_FIELDS) {
    const value = (input as Entry)[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

// Text blocks only: thinking, tool calls and tool results never reach a retain.
function textContent(content: unknown, role: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content as Entry[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) texts.push(block.text.trim());
    else if (block.type === "tool_use" && role === "assistant") {
      const message = channelMessage(block);
      if (message) texts.push(message);
    }
  }
  return texts.join("\n");
}

function stripEnvelopes(content: string): string {
  const channel = content.match(/<channel\b[^>]*>([\s\S]*?)<\/channel>/);
  return (channel ? channel[1].trim() : content)
    .replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, "")
    .replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/g, "")
    .trim();
}

// A retain after the first sends only the last role:user message of the new
// slice onward. A tool result is a role:user message, so mid-Session retains
// usually carry only the Agent's closing text; that is the integration's
// behaviour and it is kept.
function retentionTranscript(messages: Message[], fullWindow: boolean): { text: string; count: number } | null {
  let target = messages;
  if (!fullWindow) {
    const last = messages.map((m) => m.role).lastIndexOf("user");
    if (last === -1) return null;
    target = messages.slice(last);
  }
  const parts = target.flatMap((m) => {
    if (m.role !== "user" && m.role !== "assistant") return [];
    const content = stripEnvelopes(textContent(m.content, m.role));
    return content ? [`[role: ${m.role}]\n${content}\n[${m.role}:end]`] : [];
  });
  const text = parts.join("\n\n");
  return parts.length === 0 || text.trim().length < 10 ? null : { text, count: parts.length };
}

function isInterrupt(entry: Entry): boolean {
  const content = (entry.message as Entry | undefined)?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? textContent(content, "user") : "";
  return /^\[Request interrupted/.test(text.trim());
}

// A prompt the Operator (or the harness) submitted opens a model turn; a
// tool result, a meta entry or a compaction summary does not.
function opensTurn(entry: Entry): boolean {
  if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true || entry.isSidechain === true) return false;
  const content = (entry.message as Entry | undefined)?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.some((b: Entry) => b?.type === "text");
}

export interface Retain {
  documentId: string;
  content: string;
  messageCount: number;
}

// The retains the integration would have sent for this transcript. Stop fires
// when the main Agent finishes a turn (an interrupt skips it), and every 10th
// Stop retains the messages added since the last retain; SessionEnd then
// forces a final retain. Each retain after the first is its own document,
// `<session>-c<N>`, because reusing a document id replaces it.
export function stopRetains(text: string, sessionId: string): Retain[] {
  const messages: Message[] = [];
  const stops: number[] = [];
  let answered = false;
  let answeredAt = 0;
  for (const line of text.split("\n")) {
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (isInterrupt(entry)) answered = false;
    else if (opensTurn(entry) && answered) {
      stops.push(answeredAt);
      answered = false;
    }
    const message = entry.message as Entry | undefined;
    if ((entry.type === "user" || entry.type === "assistant") && message && typeof message === "object" && message.role) {
      messages.push({ role: String(message.role), content: message.content });
    }
    // Stop fires when the answer is written, before any meta entry that
    // precedes the next prompt.
    if (entry.type === "assistant" && entry.isSidechain !== true) {
      answered = true;
      answeredAt = messages.length;
    }
  }
  if (answered) stops.push(answeredAt);

  const out: Retain[] = [];
  let committed = { count: 0, chunk: 0 };
  const retain = (count: number) => {
    if (count <= committed.count) return;
    const chunk = committed.count > 0 ? committed.chunk + 1 : committed.chunk;
    const transcript = retentionTranscript(messages.slice(committed.count, count), committed.count === 0);
    committed = { count, chunk };
    if (transcript) {
      out.push({
        documentId: chunk === 0 ? sessionId : `${sessionId}-c${chunk}`,
        content: transcript.text,
        messageCount: transcript.count,
      });
    }
  };
  stops.forEach((count, i) => {
    if ((i + 1) % HINDSIGHT_PLUGIN.retainEveryNTurns === 0) retain(count);
  });
  retain(messages.length);
  return out;
}

export interface RecallResult {
  id: string;
  text: string;
  type?: string | null;
  mentioned_at?: string | null;
  document_id?: string | null;
}

// The additionalContext recall.py returns; nothing when nothing was recalled.
export function injectionText(results: RecallResult[], now: Date): string {
  if (results.length === 0) return "";
  const lines = results.map(
    (r) => `- ${r.text}${r.type ? ` [${r.type}]` : ""}${r.mentioned_at ? ` (${r.mentioned_at})` : ""}`,
  );
  const time = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `<hindsight_memories>\n${HINDSIGHT_PLUGIN.preamble}\nCurrent time - ${time}\n\n${lines.join("\n\n")}\n</hindsight_memories>`;
}

const PATH_TOKEN = /\/?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,7}\b/g;

// Hindsight units carry no file list, so the files are the paths the unit's
// text names, relative to any working directory the project ran in.
export function filesInText(text: string, cwds: string[]): string[] {
  const files = new Set<string>();
  for (const token of text.match(PATH_TOKEN) ?? []) {
    const file = token.startsWith("/") ? cwds.map((cwd) => relativeToCwd(token, cwd)).find((f) => f) : relativeToCwd(token, "");
    if (file) files.add(file);
  }
  return [...files];
}

// owners maps a unit id to the project whose bank holds it; a unit from
// another project's bank is a leak, and an unknown one is not counted as one.
export function recallItems(results: RecallResult[], owners: Map<string, string>, cwds: string[]): ProbeItem[] {
  return results.map((r) => ({
    ref: `hindsight:${r.id}`,
    kind: "memory",
    sessionId: r.document_id?.replace(/-c\d+$/, "") || undefined,
    project: owners.get(r.id),
    files: filesInText(r.text, cwds),
    text: r.text,
  }));
}
