import { parseJsonlText } from "../../src/replay/jsonl-parser.js";
import { isOperatorTurn } from "../../src/utils/operator-turn.js";

export { isOperatorTurn };

export interface UserTurn {
  turn: number;
  text: string;
  timestamp: string;
  // Text blocks of the Agent's last reply before this prompt (the text after
  // the last tool result); "" when it said nothing. Tool calls, tool results
  // and thinking are left out.
  precedingReply: string;
}

export interface FileUse {
  file: string;
  turn: number;
  mode: "read" | "edit";
}

// One main-agent Session of a Claude Code transcript. `turn` numbers the
// Operator's own prompts from 1; a tool call belongs to the last prompt that
// preceded it, and turn 0 is the Session start.
export interface ReplaySession {
  id: string;
  project: string;
  cwd: string;
  startedAt: string;
  userTurns: UserTurn[];
  fileUses: FileUse[];
  // Paths a turn's work names: in any tool call's input and in the Agent's
  // own text, cwd-relative. Wider than fileUses, for the per-turn need.
  fileMentions: FileMention[];
  sourcePath?: string;
}

// Who named the path: the Operator's typed prompt, the Agent's reply text, or
// a tool call's input.
export type MentionSource = "operator" | "agent" | "tool";

export interface FileMention {
  file: string;
  turn: number;
  source: MentionSource;
}

const READ_TOOLS = new Set(["Read"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export function relativeToCwd(file: string, cwd: string): string | null {
  if (!file.startsWith("/")) return file.replace(/^\.\//, "");
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return file.startsWith(root) ? file.slice(root.length) : null;
}

function toolFile(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const path = o.file_path ?? o.notebook_path;
  return typeof path === "string" ? path : undefined;
}

const PATH_MENTION = /(?:\/?[\w.@-]+\/)+[\w.@-]+\.\w+/g;

function mentionedFiles(text: string, cwd: string): string[] {
  return (text.match(PATH_MENTION) ?? []).flatMap((m) => relativeToCwd(m, cwd) ?? []);
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringValues);
  return [];
}

function rawEntry(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return (r.entry && typeof r.entry === "object" ? r.entry : r) as Record<string, unknown>;
}

// The first human turn stands in for the start time: the parser stamps an
// entry that has no timestamp (a leading snapshot line) with the current time.
export function parseTranscript(text: string, sourcePath?: string): ReplaySession | null {
  const parsed = parseJsonlText(text);
  const userTurns: UserTurn[] = [];
  const fileUses: FileUse[] = [];
  const fileMentions: FileMention[] = [];
  const mention = (text: string, source: MentionSource) => {
    for (const file of mentionedFiles(text, parsed.cwd)) fileMentions.push({ file, turn: userTurns.length, source });
  };
  let reply: string[] = [];
  for (const obs of parsed.observations) {
    const entry = rawEntry(obs.raw);
    if (entry.isSidechain === true) continue;
    if (obs.userPrompt !== undefined) {
      const prompt = obs.userPrompt.trim();
      if (entry.isMeta === true || entry.isCompactSummary === true) continue;
      if (!isOperatorTurn(prompt)) continue;
      userTurns.push({ turn: userTurns.length + 1, text: prompt, timestamp: obs.timestamp, precedingReply: reply.join("\n\n") });
      reply = [];
      mention(prompt, "operator");
    } else if (obs.hookType === "stop" && obs.assistantResponse) {
      reply.push(obs.assistantResponse.trim());
      mention(obs.assistantResponse, "agent");
    } else if (obs.hookType === "post_tool_use" || obs.hookType === "post_tool_failure") {
      reply = [];
    } else if (obs.hookType === "pre_tool_use" && obs.toolName) {
      const mode = READ_TOOLS.has(obs.toolName) ? "read" : EDIT_TOOLS.has(obs.toolName) ? "edit" : null;
      const abs = toolFile(obs.toolInput);
      const file = mode && abs ? relativeToCwd(abs, parsed.cwd) : null;
      if (mode && file) fileUses.push({ file, turn: userTurns.length, mode });
      for (const value of stringValues(obs.toolInput)) mention(value, "tool");
    }
  }
  if (userTurns.length === 0) return null;
  return {
    id: parsed.sessionId,
    project: parsed.project,
    cwd: parsed.cwd,
    startedAt: userTurns[0].timestamp,
    userTurns,
    fileUses,
    fileMentions,
    sourcePath,
  };
}

export function touchedFiles(session: ReplaySession): Set<string> {
  return new Set(session.fileUses.map((u) => u.file));
}

// Subagent transcripts live beside their parent as agent-*.jsonl or under a
// subagents/ directory; only the Operator's own Sessions are replayed.
export function isMainTranscriptName(name: string): boolean {
  return name.endsWith(".jsonl") && !name.startsWith("agent-");
}

export function orderByStart(sessions: ReplaySession[]): ReplaySession[] {
  return [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

type Entry = Record<string, unknown>;

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Entry[])
    .filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim())
    .map((b) => (b.text as string).trim())
    .join("\n");
}

export function isInterrupt(entry: Entry): boolean {
  return /^\[Request interrupted/.test(userText((entry.message as Entry | undefined)?.content).trim());
}

// A prompt the Operator (or the harness) submitted opens a model turn; a
// tool result, a meta entry or a compaction summary does not.
export function opensTurn(entry: Entry): boolean {
  if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true || entry.isSidechain === true) return false;
  const content = (entry.message as Entry | undefined)?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.some((b: Entry) => b?.type === "text");
}
