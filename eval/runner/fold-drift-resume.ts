import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type RunMode = "full" | "screen";

export interface RunHeader {
  store: string;
  batch: number;
  mode: RunMode;
  sessions: string[];
}

export interface RunOutcome<R> {
  results: R[];
  failed: Array<{ sessionId: string; error: string }>;
}

type Line<R> = { header: RunHeader } | { result: R } | { failed: { sessionId: string; error: string } };

export function headerMismatch(prior: RunHeader, current: RunHeader): string[] {
  const diffs: string[] = [];
  if (prior.store !== current.store) diffs.push(`store: output has ${prior.store}, this run has ${current.store}`);
  if (prior.batch !== current.batch) diffs.push(`batch: output has ${prior.batch}, this run has ${current.batch}`);
  if (prior.mode !== current.mode) diffs.push(`mode: output has ${prior.mode}, this run has ${current.mode}`);
  const missing = prior.sessions.filter((s) => !current.sessions.includes(s));
  const added = current.sessions.filter((s) => !prior.sessions.includes(s));
  if (missing.length > 0 || added.length > 0) {
    diffs.push(`sessions: output has ${missing.length} this run lacks (${missing.join(",")}), this run has ${added.length} the output lacks (${added.join(",")})`);
  }
  return diffs;
}

function readLines<R>(file: string): Array<Line<R>> {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const parsed: Array<Line<R>> = [];
  lines.forEach((text, i) => {
    try {
      parsed.push(JSON.parse(text) as Line<R>);
    } catch (err) {
      if (i !== lines.length - 1) throw err;
    }
  });
  return parsed;
}

function append(file: string, line: unknown): void {
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

// Each finished Session is appended to `file` (NDJSON) before the next starts.
// With `resume`, the Sessions already in it are not run again; a failed Session
// is not finished and runs again. A half-written last line is a Session cut off.
export async function runCheckpointed<R extends { sessionId: string }>(opts: {
  file: string;
  header: RunHeader;
  resume: boolean;
  run: (sessionId: string) => Promise<R>;
  onResult?: (r: R) => void;
  onFailure?: (sessionId: string, error: string) => void;
}): Promise<RunOutcome<R>> {
  const done = new Map<string, R>();
  if (opts.resume) {
    if (!existsSync(opts.file)) throw new Error(`cannot resume: ${opts.file} does not exist`);
    const lines = readLines<R>(opts.file);
    const first = lines[0];
    if (!first || !("header" in first)) throw new Error(`cannot resume: ${opts.file} has no header line`);
    const diffs = headerMismatch(first.header, opts.header);
    if (diffs.length > 0) throw new Error(`cannot resume ${opts.file}, it differs from this run:\n  ${diffs.join("\n  ")}`);
    for (const line of lines) if ("result" in line) done.set(line.result.sessionId, line.result);
    writeFileSync(opts.file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  } else {
    mkdirSync(dirname(opts.file), { recursive: true });
    writeFileSync(opts.file, "");
    append(opts.file, { header: opts.header });
  }

  const failed: RunOutcome<R>["failed"] = [];
  for (const sessionId of opts.header.sessions) {
    if (done.has(sessionId)) continue;
    try {
      const r = await opts.run(sessionId);
      append(opts.file, { result: r });
      done.set(sessionId, r);
      opts.onResult?.(r);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ sessionId, error });
      append(opts.file, { failed: { sessionId, error } });
      opts.onFailure?.(sessionId, error);
    }
  }
  return { results: opts.header.sessions.flatMap((s) => (done.has(s) ? [done.get(s)!] : [])), failed };
}
