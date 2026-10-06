import { parseJsonlText } from "../../src/replay/jsonl-parser.js";

export interface UserTurn {
  turn: number;
  text: string;
  timestamp: string;
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
  sourcePath?: string;
}

const READ_TOOLS = new Set(["Read"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const NOT_A_HUMAN_TURN = [
  /^<command-(name|message|args)>/,
  /^<local-command-/,
  /^\[Request interrupted/,
  /^Caveat:/,
  /^This session is being continued from a previous conversation/,
];

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
  for (const obs of parsed.observations) {
    const entry = rawEntry(obs.raw);
    if (entry.isSidechain === true) continue;
    if (obs.userPrompt !== undefined) {
      const prompt = obs.userPrompt.trim();
      if (entry.isMeta === true || entry.isCompactSummary === true) continue;
      if (NOT_A_HUMAN_TURN.some((re) => re.test(prompt))) continue;
      userTurns.push({ turn: userTurns.length + 1, text: prompt, timestamp: obs.timestamp });
    } else if (obs.hookType === "pre_tool_use" && obs.toolName) {
      const mode = READ_TOOLS.has(obs.toolName) ? "read" : EDIT_TOOLS.has(obs.toolName) ? "edit" : null;
      const abs = toolFile(obs.toolInput);
      const file = mode && abs ? relativeToCwd(abs, parsed.cwd) : null;
      if (mode && file) fileUses.push({ file, turn: userTurns.length, mode });
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
