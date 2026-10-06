#!/usr/bin/env node
import { hydrateHookEnv } from "./_env.js";
import { shouldSkipSession } from "./sdk-guard.js";
import { resolveProject, hookCwd } from "./_project.js";
import { INJECT_TIMEOUT_MS, recordMissedInjection, missReason } from "./_missed-injection.js";

hydrateHookEnv();

// Session-start hook.
//
// Always registers the session for observation tracking (so memories
// captured on PostToolUse get attached to the right session). Only writes
// project context to stdout — which Claude Code prepends to the very first
// turn — when AGENTMEMORY_INJECT_CONTEXT=true. Default off as of 0.8.10
// (rohitg00/agentmemory#143).
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

// When the server is unreachable a 5s timeout multiplies hard under
// concurrent fan-out (Slack bots, multi-agent harnesses) and becomes a
// positive feedback loop that OOM-kills iii-engine (#221). Cap tight on
// both paths and skip the await entirely when the response is unused.
const REGISTER_TIMEOUT_MS = 800;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

function contextPayload(data: Record<string, unknown>, context: string): string {
  if (data.prompt_id !== undefined) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    });
  }
  return context;
}

async function main() {
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
  // A subagent that compacts fires SessionStart with its parent's session_id;
  // the parent Session is already registered and the subagent is mid-task.
  if (typeof data.agent_id === "string" && data.agent_id) return;

  const sessionId =
    (data.session_id as string) ||
    `ses_${Date.now().toString(36)}`;
  const cwd = hookCwd(data) || process.cwd();
  const project = resolveProject(cwd);

  const url = `${REST_URL}/agentmemory/session/start`;
  const init: RequestInit = {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ sessionId, project, cwd }),
  };

  if (!INJECT_CONTEXT) {
    // Pure telemetry path: caller never reads the response, so don't
    // block on it. AbortSignal.timeout caps the wait the event loop
    // gives the pending socket before exit.
    fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    }).catch(() => {});
    return;
  }

  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
    });
    if (res.ok) {
      const result = (await res.json()) as { context?: string };
      if (result.context) {
        process.stdout.write(contextPayload(data, result.context));
      }
    } else {
      recordMissedInjection("session-start", `http_${res.status}`);
    }
  } catch (err) {
    recordMissedInjection("session-start", missReason(err));
    // silently fail -- don't block Claude Code startup
  }
}

main().catch(() => process.exit(0));
