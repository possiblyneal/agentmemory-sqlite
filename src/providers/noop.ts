import type { MemoryProvider } from "../types.js";

/**
 * Returns empty strings for every call. Used when no LLM API key is set
 * AND the user has not opted into the agent-sdk fallback via
 * AGENTMEMORY_ALLOW_AGENT_SDK=true. Callers (compress, summarize) must
 * detect the empty result and short-circuit instead of spawning a
 * provider session (#149 / Stop-hook recursion loop fix).
 */
export class NoopProvider implements MemoryProvider {
  name = "noop";

  async compress(): Promise<string> {
    return "";
  }

  async summarize(): Promise<string> {
    return "";
  }
}

const RESILIENT_PREFIX = "resilient(";

/**
 * Every provider is wrapped as `resilient(<inner>)`, so callers must look
 * through the wrapper rather than compare against "noop" directly.
 */
export function isNoopProvider(provider: Pick<MemoryProvider, "name">): boolean {
  let name = provider.name;
  while (name.startsWith(RESILIENT_PREFIX) && name.endsWith(")")) {
    name = name.slice(RESILIENT_PREFIX.length, -1);
  }
  return name === "noop";
}
