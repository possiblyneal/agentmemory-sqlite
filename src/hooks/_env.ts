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

// Memoized per path: getMergedEnv() runs on every config getter, so the daemon
// would otherwise reread the file dozens of times per request. Keying on the
// path keeps a test that points HOME elsewhere from reading a stale file.
let envFileCache: { path: string; vars: Record<string, string> } | undefined;

export function loadEnvFile(): Record<string, string> {
  const path = join(homedir(), ".agentmemory", ".env");
  if (envFileCache?.path === path) return envFileCache.vars;
  let vars: Record<string, string>;
  try {
    vars = parseEnvFile(readFileSync(path, "utf-8"));
  } catch {
    vars = {};
  }
  envFileCache = { path, vars };
  return vars;
}

// Test hook for a test that rewrites the file without reloading this module.
export function __resetEnvFileCache(): void {
  envFileCache = undefined;
}

// Copies the env file into process.env for every key the caller's isUnset
// says has no value yet, so a value already in process.env wins.
export function hydrateEnvFromFile(isUnset: (current: string | undefined) => boolean): void {
  for (const [key, value] of Object.entries(loadEnvFile())) {
    if (isUnset(process.env[key])) process.env[key] = value;
  }
}

export function hydrateHookEnv(): void {
  hydrateEnvFromFile((current) => current === undefined);
}
