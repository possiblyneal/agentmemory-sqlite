#!/usr/bin/env node
import { hydrateHookEnv } from "./_env.js";
import { shouldSkipSession } from "./sdk-guard.js";
import { resolveProject, hookCwd } from "./_project.js";

const MAX_REPLY_CHARS = 4000;

hydrateHookEnv();

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

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

  // A reply closes on its recap and the question the user answers next, so a
  // long one keeps its tail as well as its head.
  const message = typeof data.last_assistant_message === "string" ? data.last_assistant_message : "";
  const reply =
    message.length > MAX_REPLY_CHARS
      ? `${message.slice(0, MAX_REPLY_CHARS / 2)}\n…\n${message.slice(-MAX_REPLY_CHARS / 2)}`
      : message;
  if (reply) {
    const cwd = hookCwd(data) || process.cwd();
    fetch(`${REST_URL}/agentmemory/observe`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        hookType: "stop",
        sessionId,
        project: resolveProject(cwd),
        cwd,
        timestamp: new Date().toISOString(),
        data: { last_message: reply },
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  // session/end already fans out the summary server-side (#1203). Stop
  // fires after every turn, so the daemon holds the end until the Session
  // goes idle (#1131).
  fetch(`${REST_URL}/agentmemory/session/end`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ sessionId, turnEnd: true }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});

  setTimeout(() => process.exit(0), 1500).unref();
}

main().catch(() => process.exit(0));
