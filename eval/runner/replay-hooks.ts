import { parseJsonlText } from "../../src/replay/jsonl-parser.js";
import type { ReplaySession } from "./replay-transcript.js";

export interface HookPayload {
  hookType: "prompt_submit" | "post_tool_use" | "post_tool_failure";
  sessionId: string;
  project: string;
  cwd: string;
  timestamp: string;
  data: Record<string, unknown>;
}

const TOOL_OUTPUT_CHARS = 8000;
const FAILURE_CHARS = 4000;

function rawEntry(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return (r.entry && typeof r.entry === "object" ? r.entry : r) as Record<string, unknown>;
}

function truncate(value: unknown, max: number): unknown {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}\n[...truncated]` : value;
  const str = JSON.stringify(value ?? "");
  return str.length > max ? `${str.slice(0, max)}...[truncated]` : value;
}

function clip(value: unknown, max: number): string {
  return (typeof value === "string" ? value : JSON.stringify(value ?? "")).slice(0, max);
}

// What the plugin hooks would have posted to /observe during this Session:
// each prompt the Operator submitted (UserPromptSubmit), and each tool call
// once its result came back (PostToolUse / PostToolUseFailure), with the
// hooks' own truncation. Assistant text, harness-written meta turns and
// sidechain entries never reach a hook.
export function hookPayloads(text: string, session: ReplaySession): HookPayload[] {
  const base = { sessionId: session.id, project: session.project, cwd: session.cwd };
  const calls = new Map<string, { name?: string; input: unknown }>();
  const out: HookPayload[] = [];
  for (const obs of parseJsonlText(text).observations) {
    const entry = rawEntry(obs.raw);
    if (entry.isSidechain === true) continue;
    if (obs.hookType === "prompt_submit") {
      if (entry.isMeta === true) continue;
      out.push({ ...base, hookType: "prompt_submit", timestamp: obs.timestamp, data: { prompt: obs.userPrompt } });
    } else if (obs.hookType === "pre_tool_use") {
      const id = (obs.raw as { toolUseId?: string }).toolUseId;
      if (id) calls.set(id, { name: obs.toolName, input: obs.toolInput });
    } else if (obs.hookType === "post_tool_use" || obs.hookType === "post_tool_failure") {
      const call = calls.get((obs.toolInput as { toolUseId?: string }).toolUseId ?? "");
      if (!call) continue;
      const data =
        obs.hookType === "post_tool_use"
          ? { tool_name: call.name, tool_input: call.input, tool_output: truncate(entry.toolUseResult ?? obs.toolOutput, TOOL_OUTPUT_CHARS) }
          : { tool_name: call.name, tool_input: clip(call.input, FAILURE_CHARS), error: clip(obs.toolOutput, FAILURE_CHARS) };
      out.push({ ...base, hookType: obs.hookType, timestamp: obs.timestamp, data });
    }
  }
  return out;
}
