// Thin logging shim for agentmemory.
//
// A single `logger` singleton with an `.info/.warn/.error` signature, so no
// call site has to care about the OTEL Logger API shape (`emit(...)` with
// severity numbers and attributes maps). If we later want structured OTEL
// logs, this file is the only thing that changes.
//
// Output goes to stderr as `[agentmemory] <level> <msg> <json-fields>`,
// which systemd captures into the journal.

type Fields = Record<string, unknown> | undefined;

// AGENTMEMORY_LOG_LEVEL=info|warn|error|off: the lowest level still written
// (default info, which is everything, as before the switch existed). Read
// per call so a test can flip it. `logger.audit` bypasses it: at `warn` the
// deletion evidence would otherwise vanish together with the info chatter.
const LEVEL_RANK = new Map([["info", 0], ["warn", 1], ["error", 2], ["off", 3]]);

function enabled(level: "info" | "warn" | "error"): boolean {
  const lowest = LEVEL_RANK.get((process.env.AGENTMEMORY_LOG_LEVEL ?? "info").toLowerCase()) ?? 0;
  return (LEVEL_RANK.get(level) ?? 0) >= lowest;
}

function fmt(level: string, msg: string, fields: Fields): string {
  if (!fields || Object.keys(fields).length === 0) {
    return `[agentmemory] ${level} ${msg}`;
  }
  try {
    return `[agentmemory] ${level} ${msg} ${JSON.stringify(fields)}`;
  } catch {
    // Fields contained a circular reference or a BigInt — fall back
    // to the plain message so a log line never throws.
    return `[agentmemory] ${level} ${msg}`;
  }
}

function emit(level: string, msg: string, fields: Fields): void {
  try {
    process.stderr.write(fmt(level, msg, fields) + "\n");
  } catch {
    // stderr is unavailable in some weird test/worker contexts — swallow
    // so no log line can ever crash a handler.
  }
}

export const logger = {
  info(msg: string, fields?: Fields): void {
    if (enabled("info")) emit("info", msg, fields);
  },
  warn(msg: string, fields?: Fields): void {
    if (enabled("warn")) emit("warn", msg, fields);
  },
  error(msg: string, fields?: Fields): void {
    if (enabled("error")) emit("error", msg, fields);
  },
  // `[agentmemory] audit <operation> <json>`; never filtered by the level.
  audit(operation: string, fields?: Fields): void {
    emit("audit", operation, fields);
  },
};

// ---------- boot log ----------
//
// `bootLog` is for the one-shot status lines that every register-*
// function used to dump via `console.log` during engine startup. On a
// fresh install that's ~25 lines of `[agentmemory] X enabled` noise
// before the user can see a prompt. In quiet mode (default), each
// line is captured into a buffer and discarded; the CLI surfaces a
// single compressed summary instead. In verbose mode (set by
// `--verbose` or `AGENTMEMORY_VERBOSE=1`) the lines pass straight
// through to stderr exactly like the old console.log calls.

function envWantsBootVerbose(): boolean {
  return (
    process.env["AGENTMEMORY_VERBOSE"] === "1" ||
    process.env["AGENTMEMORY_VERBOSE"] === "true"
  );
}

let bootVerbose = envWantsBootVerbose();

// This module is imported long before `~/.agentmemory/.env` is folded into
// process.env, so the snapshot above can only see a variable the unit already
// exported. `hydrateProcessEnvFromFile` calls this afterwards so the setting
// works from the .env file too. It only ever turns verbosity on: `--verbose`
// may already have set it and the file must not switch that back off.
export function refreshBootVerbose(): void {
  bootVerbose = bootVerbose || envWantsBootVerbose();
}

const bootBuffer: string[] = [];

export function setBootVerbose(enabled: boolean): void {
  bootVerbose = enabled;
}

export function isBootVerbose(): boolean {
  return bootVerbose;
}

export function bootLog(msg: string): void {
  if (bootVerbose) {
    try {
      process.stderr.write(`[agentmemory] ${msg}\n`);
    } catch {
      // stderr unavailable — drop.
    }
    return;
  }
  if (bootBuffer.length < 500) bootBuffer.push(msg);
}

export function bootWarn(msg: string): void {
  // Warnings always surface; they're rare and the user needs to see
  // them even when the rest of the boot log is suppressed.
  try {
    process.stderr.write(`[agentmemory] warn ${msg}\n`);
  } catch {}
}

export function getBootBuffer(): readonly string[] {
  return bootBuffer;
}
