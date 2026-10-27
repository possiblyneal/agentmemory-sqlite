import { parseJsonlText } from "../../src/replay/jsonl-parser.js";
import { isInterrupt, opensTurn } from "./replay-hindsight.js";
import { isOperatorTurn, type ReplaySession } from "./replay-transcript.js";

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

export type HookStep = { step: "observe"; payload: HookPayload } | { step: "stop" };

// What the plugin hooks would have posted to /observe during this Session:
// each prompt the Operator submitted (UserPromptSubmit), and each tool call
// once its result came back (PostToolUse / PostToolUseFailure), with the
// hooks' own truncation. Assistant text, harness-written meta turns and
// sidechain entries never reach a hook. A `stop` step marks where the Stop
// hook fires: the main Agent finished a turn, and the next prompt, not an
// interrupt, opens another (the Hindsight replay counts Stops the same way).
export function hookSteps(text: string, session: ReplaySession): HookStep[] {
  const base = { sessionId: session.id, project: session.project, cwd: session.cwd };
  const calls = new Map<string, { name?: string; input: unknown }>();
  const out: HookStep[] = [];
  let answered = false;
  const observe = (payload: HookPayload) => out.push({ step: "observe", payload });
  for (const obs of parseJsonlText(text).observations) {
    const entry = rawEntry(obs.raw);
    if (entry.isSidechain === true) continue;
    if (isInterrupt(entry)) answered = false;
    else if (answered && opensTurn(entry)) {
      out.push({ step: "stop" });
      answered = false;
    }
    if (obs.hookType === "stop" || obs.hookType === "pre_tool_use") answered = true;
    if (obs.hookType === "prompt_submit") {
      if (entry.isMeta === true || !isOperatorTurn(obs.userPrompt ?? "")) continue;
      observe({ ...base, hookType: "prompt_submit", timestamp: obs.timestamp, data: { prompt: obs.userPrompt } });
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
      observe({ ...base, hookType: obs.hookType, timestamp: obs.timestamp, data });
    }
  }
  if (answered) out.push({ step: "stop" });
  return out;
}

export function hookPayloads(text: string, session: ReplaySession): HookPayload[] {
  return hookSteps(text, session).flatMap((s) => (s.step === "observe" ? [s.payload] : []));
}

// How the daemon's summarize calls went, read from its log: a fold into the
// prior Summary, a full pass (single or chunked, a fold's fallback included),
// or a Summary already current.
export function summarizeCounts(log: string): { folded: number; full: number; reused: number } {
  const counts = { folded: 0, full: 0, reused: 0 };
  for (const line of log.split("\n")) {
    if (line.includes("info Session Summary current, reused")) counts.reused++;
    else if (line.includes("info Session summarized")) counts[line.includes('"mode":"folded"') ? "folded" : "full"]++;
  }
  return counts;
}

export interface HookStepIo {
  observe(payload: HookPayload): Promise<void>;
  drain(): Promise<void>;
  summarize(): Promise<boolean>;
}

// Plays the steps in transcript order. A stop waits for the Observations
// posted so far to be compressed, then summarizes, so the daemon's own fold
// logic sees what a live Stop would. Returns how many summarize calls ran and
// how many produced a Summary.
export async function runHookSteps(steps: HookStep[], io: HookStepIo): Promise<{ summarizeCalls: number; summarized: number }> {
  let summarizeCalls = 0;
  let summarized = 0;
  for (const step of steps) {
    if (step.step === "observe") {
      await io.observe(step.payload);
      continue;
    }
    await io.drain();
    summarizeCalls++;
    if (await io.summarize()) summarized++;
  }
  return { summarizeCalls, summarized };
}
