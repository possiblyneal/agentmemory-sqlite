/**
 * Skip guard shared by every hook script.
 *
 * Two kinds of Session never reach agentmemory:
 *
 *   1. agentmemory's own summarize/compress calls. The agent-sdk provider
 *      sets AGENTMEMORY_SDK_CHILD=1 before it spawns `query()`, and the
 *      child inherits it. Capturing that child would summarize it through
 *      the same provider and recurse without bound (#149 follow-up). This
 *      skip is unconditional.
 *   2. Headless Sessions: any CLAUDE_CODE_ENTRYPOINT starting "sdk-", which
 *      today is `claude -p` ("sdk-cli"), the TS Agent SDK ("sdk-ts") and
 *      the Python Agent SDK ("sdk-py"). These are almost always scripted
 *      batches whose summaries are noise, and a batch of thousands
 *      saturates the summarizing LLM. Set AGENTMEMORY_CAPTURE_HEADLESS=1
 *      to capture them.
 *
 * Claude Code puts the entrypoint in the hook's environment, never in the
 * stdin payload.
 */
export function shouldSkipSession(): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (process.env["AGENTMEMORY_CAPTURE_HEADLESS"] === "1") return false;
  return process.env["CLAUDE_CODE_ENTRYPOINT"]?.startsWith("sdk-") ?? false;
}
