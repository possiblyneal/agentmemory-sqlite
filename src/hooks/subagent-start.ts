#!/usr/bin/env node
import { hydrateHookEnv } from "./_env.js";
import { shouldSkipSession } from "./sdk-guard.js";
import { resolveProject, hookCwd } from "./_project.js";

hydrateHookEnv();

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

// Passive telemetry only — nothing reads the response, so the previous
// `await` was pure latency. Tightened from 2000ms to a defensive cap so a
// slow/unreachable server can't stack onto every concurrent subagent
// startup (#221).
const TIMEOUT_MS = 800;

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
  const agentId = data.agent_id;
  const agentType = data.agent_type;

  const cwd = hookCwd(data) || process.cwd();

  fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      hookType: "subagent_start",
      sessionId,
      project: resolveProject(cwd),
      cwd,
      timestamp: new Date().toISOString(),
      data: {
        agent_id: agentId,
        agent_type: agentType,
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {});
  setTimeout(() => process.exit(0), 500).unref();
}

main().catch(() => process.exit(0));
