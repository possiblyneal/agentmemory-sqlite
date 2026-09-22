import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Hook scripts run as fresh Node processes that never import the Engine, so
// a setting the Operator placed in ~/.agentmemory/.env reaches them only
// through this loader. Same parse rules as the daemon's env file reader; a
// key already present in process.env wins. The daemon's loader imports this
// parser, so both read the file by the same rules.
export function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    const quoteChar = val[0] === '"' || val[0] === "'" ? val[0] : "";
    if (quoteChar) {
      const closeIdx = val.indexOf(quoteChar, 1);
      if (closeIdx !== -1) val = val.slice(1, closeIdx);
    } else {
      const hashIdx = val.indexOf(" #");
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    vars[key] = val;
  }
  return vars;
}

export function hydrateHookEnv(): void {
  let content: string;
  try {
    content = readFileSync(join(homedir(), ".agentmemory", ".env"), "utf-8");
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnvFile(content))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
