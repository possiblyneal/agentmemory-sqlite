import type {
  RawObservation,
  CompressedObservation,
  ObservationType,
} from "../types.js";
import { truncate as truncateMiddleOut } from "../prompts/compression.js";

// Zero-LLM compression path. Converts a RawObservation into a
// CompressedObservation using only heuristics — no Claude call, no token
// spend. This is the default as of 0.8.8 (#138); users who want richer
// LLM-generated summaries set AGENTMEMORY_AUTO_COMPRESS=true.

// Tool names the word matching below misreads: TaskUpdate is not a file edit,
// ToolSearch is not a code search, and every claude-in-chrome tool is the web.
const TOOL_TYPES: Array<[RegExp, ObservationType]> = [
  [/^Write$/, "file_write"],
  [/^(Agent|Task\w*|SendMessage|ListAgents)$/, "subagent"],
  [/^AskUserQuestion$/, "decision"],
  [/^(Skill|ToolSearch)$/, "other"],
  [/^mcp__claude-in-chrome__/, "web_fetch"],
];

function inferType(
  toolName: string | undefined,
  hookType: string,
): ObservationType {
  if (hookType === "post_tool_failure") return "error";
  if (hookType === "prompt_submit") return "conversation";
  if (
    hookType === "subagent_start" ||
    hookType === "subagent_stop" ||
    hookType === "task_completed"
  )
    return "subagent";
  if (hookType === "notification") return "notification";

  if (!toolName) return "other";
  const listed = TOOL_TYPES.find(([pattern]) => pattern.test(toolName));
  if (listed) return listed[1];
  // Normalize camelCase and kebab-case into word chunks so we can match
  // substrings like "WebFetch" -> "web" / "fetch".
  const n = toolName
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  const hasWord = (word: string) =>
    new RegExp(`(^|_)${word}(_|$)`).test(n) ||
    n === word ||
    n.endsWith(word) ||
    n.startsWith(word);
  if (["fetch", "http", "web"].some(hasWord)) return "web_fetch";
  if (["grep", "search", "glob", "find"].some(hasWord)) return "search";
  if (["bash", "shell", "exec", "run"].some(hasWord)) return "command_run";
  if (["edit", "update", "patch", "replace"].some(hasWord)) return "file_edit";
  if (["write", "create"].some(hasWord)) return "file_write";
  if (["read", "view"].some(hasWord)) return "file_read";
  if (["task", "agent"].some(hasWord)) return "subagent";
  return "other";
}

function extractFiles(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const out = new Set<string>();
  for (const key of [
    "file_path",
    "filepath",
    "path",
    "filePath",
    "file",
    "pattern",
  ]) {
    const v = o[key];
    if (typeof v === "string" && v.length > 0 && v.length < 512) out.add(v);
  }
  return [...out];
}

function stringifyForNarrative(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Titles and narrative for hooks whose payload carries no tool fields. The
// payload shapes are what src/hooks/{subagent-start,subagent-stop,
// task-completed,notification}.ts send.
function describeHook(
  raw: RawObservation,
): { title: string; narrative: string } | undefined {
  const d =
    raw.raw && typeof raw.raw === "object"
      ? (raw.raw as Record<string, unknown>)
      : {};
  const join = (parts: string[]) => parts.filter(Boolean).join(" | ");
  switch (raw.hookType) {
    case "subagent_start": {
      const kind = str(d["agent_type"]);
      const id = str(d["agent_id"]);
      if (!kind && !id) return undefined;
      return {
        title: `Subagent started: ${kind || id}`,
        narrative: join([kind && `type ${kind}`, id && `id ${id}`]),
      };
    }
    case "subagent_stop": {
      const kind = str(d["agent_type"]);
      const id = str(d["agent_id"]);
      const last = str(d["last_message"]);
      if (!kind && !id && !last) return undefined;
      return {
        title: `Subagent finished: ${kind || id || oneLine(last)}`,
        narrative: join([last, id && `id ${id}`]),
      };
    }
    case "task_completed": {
      const subject = str(d["task_subject"]);
      const description = str(d["task_description"]);
      if (!subject && !description) return undefined;
      return {
        title: `Task completed: ${subject || oneLine(description)}`,
        narrative: join([
          subject,
          description,
          str(d["teammate_name"]) && `teammate ${str(d["teammate_name"])}`,
          str(d["team_name"]) && `team ${str(d["team_name"])}`,
        ]),
      };
    }
    case "notification": {
      const title = str(d["title"]);
      const message = str(d["message"]);
      if (!title && !message) return undefined;
      return {
        title: oneLine(title || message),
        narrative: join([title, message]),
      };
    }
    default:
      return undefined;
  }
}

export function buildSyntheticCompression(
  raw: RawObservation,
): CompressedObservation {
  const toolName = raw.toolName ?? raw.hookType;
  const inputStr = stringifyForNarrative(raw.toolInput);
  const outputStr = stringifyForNarrative(raw.toolOutput);
  const promptStr = raw.userPrompt ?? "";

  const narrativeParts = [promptStr, inputStr, outputStr].filter(
    (s) => s.length > 0,
  );

  const hook = describeHook(raw);
  let title = toolName || "observation";
  if (hook) title = hook.title;
  else if (raw.hookType === "prompt_submit" && oneLine(promptStr))
    title = oneLine(promptStr);
  else if (raw.hookType === "post_tool_failure" && raw.toolName)
    title = `${raw.toolName} failed`;

  const result: CompressedObservation = {
    id: raw.id,
    sessionId: raw.sessionId,
    timestamp: raw.timestamp,
    type: inferType(toolName, raw.hookType),
    title: truncate(title, 80),
    subtitle: inputStr ? truncate(inputStr, 120) : undefined,
    facts: [],
    // Middle-out at 2000 (was head-only at 400): the tail of a log or prompt
    // is usually the part that matters, and 400 chars of head lost it.
    narrative: truncateMiddleOut(
      hook ? hook.narrative : narrativeParts.join(" | "),
      2000,
    ),
    concepts: [],
    files: extractFiles(raw.toolInput),
    importance: 5,
    confidence: 0.3,
  };
  if (raw.toolName) result.toolName = raw.toolName;
  if (raw.userPrompt) result.userPrompt = raw.userPrompt;
  if (raw.modality) result.modality = raw.modality;
  if (raw.imageData) result.imageData = raw.imageData;
  if (raw.agentId) result.agentId = raw.agentId;
  if (raw.origin) result.origin = raw.origin;
  return result;
}
