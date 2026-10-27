import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hydrateProcessEnvFromFile, loadConfig } from "../../src/config.js";
import { createProvider } from "../../src/providers/index.js";
import { isNoopProvider } from "../../src/providers/noop.js";
import type { Complete } from "./decision-key.js";

// Private, so under tmp/ like the rest of replay's output.
export const DECISION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../tmp/eval-replay");
export const DECISION_KEY_PATH = join(DECISION_DIR, "decision-key.json");
export const DECISION_VERDICTS_PATH = join(DECISION_DIR, "decision-verdicts.ndjson");

// The daemon's own provider, the one `eval:replay --llm` and `eval:fold-drift`
// run on (OPENAI_* from the shell, else ~/.agentmemory/.env).
export function providerComplete(): Complete {
  hydrateProcessEnvFromFile();
  const provider = createProvider(loadConfig().provider);
  if (isNoopProvider(provider)) {
    throw new Error("no LLM provider configured: set OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL in the shell or ~/.agentmemory/.env");
  }
  return (system, user) => provider.summarize(system, user);
}
