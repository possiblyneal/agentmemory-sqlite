import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hydrateProcessEnvFromFile, loadConfig } from "../../src/config.js";
import { createProvider } from "../../src/providers/index.js";
import { isNoopProvider } from "../../src/providers/noop.js";
import type { Complete } from "./decision-key.js";
import { EVAL_LLM_SAMPLING } from "./sandbox.js";

// Private, so under tmp/ like the rest of replay's output.
export const DECISION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../tmp/eval-replay");
export const DECISION_KEY_PATH = join(DECISION_DIR, "decision-key.json");
export const DECISION_VERDICTS_PATH = join(DECISION_DIR, "decision-verdicts.ndjson");

// The daemon's own provider, the one `eval:replay --llm` and `eval:fold-drift`
// run on (OPENAI_* from the shell, else ~/.agentmemory/.env), decoding
// greedily as the replay's daemon does.
export function providerComplete(): Complete {
  hydrateProcessEnvFromFile();
  process.env.OPENAI_EXTRA_BODY = EVAL_LLM_SAMPLING;
  const provider = createProvider(loadConfig().provider);
  if (isNoopProvider(provider)) {
    throw new Error("no LLM provider configured: set OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL in the shell or ~/.agentmemory/.env");
  }
  return withRetries((system, user) => provider.summarize(system, user));
}

// A replay is not resumable, so one dropped connection to a busy broker must
// not end it: a thrown call is retried after a pause, and only the last
// attempt's error escapes.
export function withRetries(complete: Complete, attempts = 4, delayMs = 30_000): Complete {
  return async (system, user) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await complete(system, user);
      } catch (err) {
        if (attempt >= attempts) throw err;
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      }
    }
  };
}
