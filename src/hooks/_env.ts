import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The one reader of ~/.agentmemory/.env, shared by the daemon's config, the
// hook scripts, the standalone MCP server and doctor. It lives under hooks/
// because hook bundles must not pull in config.ts and its logger state.
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

export function envFilePath(): string {
  return join(homedir(), ".agentmemory", ".env");
}

// A missing file is an empty one; any other read error reaches the caller.
export function readEnvFile(): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(envFilePath(), "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

// Memoized per path: getMergedEnv() runs on every config getter, so the daemon
// would otherwise reread the file dozens of times per request. Keying on the
// path keeps a test that points HOME elsewhere from reading a stale file.
let envFileCache: { path: string; vars: Record<string, string> } | undefined;

export function loadEnvFile(): Record<string, string> {
  const path = envFilePath();
  if (envFileCache?.path === path) return envFileCache.vars;
  const vars = readEnvFile();
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

// A hook is never on the critical path, so an unreadable file means no settings.
export function hydrateHookEnv(): void {
  try {
    hydrateEnvFromFile((current) => current === undefined);
  } catch {}
}
