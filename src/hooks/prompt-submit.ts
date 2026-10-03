#!/usr/bin/env node
import { hydrateHookEnv } from "./_env.js";
import { shouldSkipSession } from "./sdk-guard.js";
import { resolveProject, hookCwd } from "./_project.js";
import { recordMissedInjection, missReason } from "./_missed-injection.js";

hydrateHookEnv();

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";
const INJECT_TIMEOUT_MS = 1500;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
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

  const sessionId = ((data.session_id || data.sessionId || data.conversation_id) as string) || "unknown";

  const cwd = hookCwd(data) || process.cwd();
  const project = resolveProject(cwd);
  const prompt = data.prompt ?? data.userPrompt;

  fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      hookType: "prompt_submit",
      sessionId,
      project,
      cwd,
      timestamp: new Date().toISOString(),
      data: { prompt },
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});

  // Only Claude Code's UserPromptSubmit reads additionalContext from stdout;
  // other hosts run this script as telemetry. Subagent prompts are skipped.
  if (INJECT_CONTEXT && data.hook_event_name === "UserPromptSubmit" && !data.agent_id && typeof prompt === "string") {
    await injectContext(sessionId, project, prompt);
  }
  setTimeout(() => process.exit(0), 500).unref();
}

async function injectContext(sessionId: string, project: string, prompt: string): Promise<void> {
  try {
    const res = await fetch(`${REST_URL}/agentmemory/prompt-context`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ sessionId, project, prompt }),
      signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
    });
    if (!res.ok) {
      recordMissedInjection("prompt-submit", `http_${res.status}`);
      return;
    }
    const result = (await res.json()) as { context?: string };
    if (result.context) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: result.context },
        }),
      );
    }
  } catch (err) {
    recordMissedInjection("prompt-submit", missReason(err));
  }
}

main().catch(() => process.exit(0));
