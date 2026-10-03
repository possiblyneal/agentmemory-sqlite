#!/usr/bin/env node
import { hydrateHookEnv } from "./_env.js";
import { shouldSkipSession } from "./sdk-guard.js";
import { resolveProject, hookCwd } from "./_project.js";
import { recordMissedInjection, missReason } from "./_missed-injection.js";

hydrateHookEnv();

// Pre-tool-use enrichment hook.
//
// THIS HOOK IS A NO-OP BY DEFAULT. When on, it fires /agentmemory/enrich on
// every Edit/Write/Read/Glob/Grep tool call and writes up to 4000 chars of
// context for the model's next turn, so session input tokens grow with the
// number of file-touching tool calls (rohitg00/agentmemory#143).
//
// It needs its own opt-in on top of the session-start one, so an Operator
// can keep session-start Injection without paying per tool call:
//   AGENTMEMORY_INJECT_CONTEXT=true
//   AGENTMEMORY_INJECT_TOOL_CONTEXT=true   in ~/.agentmemory/.env
// (read by hydrateHookEnv above on every hook run; a shell-exported value
// wins) and restart Claude Code.
const INJECT_CONTEXT =
  process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true" &&
  process.env["AGENTMEMORY_INJECT_TOOL_CONTEXT"] === "true";

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

// Claude Code drops plain PreToolUse stdout into the debug log; only the
// hookSpecificOutput envelope reaches the model. Hosts that send no
// hook_event_name keep the plain text they have always read.
function contextPayload(data: Record<string, unknown>, context: string): string {
  if (data.hook_event_name === "PreToolUse") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: context,
      },
    });
  }
  return context;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

async function main() {
  // Default off: exit immediately so we don't even open stdin. This keeps
  // Claude Code's tool-call hot path as cheap as possible.
  if (!INJECT_CONTEXT) return;

  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (!data || typeof data !== "object") return;
  if (shouldSkipSession()) return;

  const toolName =
    typeof data.tool_name === "string"
      ? data.tool_name
      : typeof data.toolName === "string"
        ? data.toolName
        : undefined;
  if (!toolName) return;

  const normalizedToolName = toolName.toLowerCase();
  const fileTools = ["edit", "write", "create", "read", "view", "glob", "grep"];
  if (!fileTools.includes(normalizedToolName)) return;

  const rawToolInput = data.tool_input ?? data.toolArgs;
  const toolInput =
    typeof rawToolInput === "object" &&
    rawToolInput !== null &&
    !Array.isArray(rawToolInput)
      ? (rawToolInput as Record<string, unknown>)
      : {};
  const files: string[] = [];
  const fileKeys =
    normalizedToolName === "grep"
      ? ["path", "file"]
      : ["file_path", "path", "file", "pattern"];
  for (const key of fileKeys) {
    const val = toolInput[key];
    if (typeof val === "string" && val.length > 0) files.push(val);
  }
  if (files.length === 0) return;

  const terms: string[] = [];
  if (normalizedToolName === "grep" || normalizedToolName === "glob") {
    const pattern = toolInput["pattern"];
    if (typeof pattern === "string" && pattern.length > 0) {
      terms.push(pattern);
    }
  }

  const rawSessionId = data.session_id || data.sessionId || data.conversation_id;
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.length > 0
      ? rawSessionId
      : "unknown";
  const project =
    typeof data.project === "string" && data.project.trim().length > 0
      ? data.project.trim()
      : resolveProject(hookCwd(data));

  try {
    const res = await fetch(`${REST_URL}/agentmemory/enrich`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        sessionId,
        files,
        terms,
        toolName,
        ...(project && { project }),
      }),
      signal: AbortSignal.timeout(2000),
    });

    if (res.ok) {
      const result = (await res.json()) as { context?: string };
      if (result.context) {
        process.stdout.write(contextPayload(data, result.context));
      }
    } else {
      recordMissedInjection("pre-tool-use", `http_${res.status}`);
    }
  } catch (err) {
    recordMissedInjection("pre-tool-use", missReason(err));
    // don't block tool execution
  }
}

main().catch(() => process.exit(0));
