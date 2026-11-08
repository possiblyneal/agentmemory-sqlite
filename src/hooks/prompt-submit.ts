#!/usr/bin/env node
import { hydrateHookEnv } from "./_env.js";
import { shouldSkipSession } from "./sdk-guard.js";
import { resolveProject, hookCwd } from "./_project.js";
import { INJECT_TIMEOUT_MS, recordMissedInjection, missReason } from "./_missed-injection.js";
import { lastAgentReply } from "./_last-reply.js";
import { isTersePrompt } from "../utils/terse-prompt.js";

hydrateHookEnv();

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";

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

  const sessionId = (data.session_id as string) || "unknown";

  const cwd = hookCwd(data) || process.cwd();
  const project = resolveProject(cwd);
  const prompt = data.prompt;
  const timestamp = new Date().toISOString();

  // Only Claude Code's UserPromptSubmit reads additionalContext from stdout;
  // other hosts run this script as telemetry. Subagent prompts are skipped.
  if (INJECT_CONTEXT && data.hook_event_name === "UserPromptSubmit" && !data.agent_id && typeof prompt === "string") {
    await injectContext(sessionId, project, prompt, data.transcript_path);
  }
  // Observed after the Injection: indexed first, the prompt would match its
  // own search and dilute every earlier Session's score.
  fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      hookType: "prompt_submit",
      sessionId,
      project,
      cwd,
      timestamp,
      data: { prompt },
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
  setTimeout(() => process.exit(0), 500).unref();
}

// A terse prompt carries the Agent's last reply for prompt-context to search
// on; an unreadable transcript sends the prompt alone.
async function replyFor(prompt: string, transcriptPath: unknown): Promise<string> {
  if (!isTersePrompt(prompt) || typeof transcriptPath !== "string") return "";
  return lastAgentReply(transcriptPath).catch(() => "");
}

async function injectContext(sessionId: string, project: string, prompt: string, transcriptPath: unknown): Promise<void> {
  try {
    const reply = await replyFor(prompt, transcriptPath);
    const res = await fetch(`${REST_URL}/agentmemory/prompt-context`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ sessionId, project, prompt, ...(reply && { reply }) }),
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
