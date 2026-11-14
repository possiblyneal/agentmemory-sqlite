import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { appendDurable, repairNdjson, writeFileAtomic } from "./durable.js";
import type { LlmProfile } from "./fold-drift-core.js";

export type RunMode = "full" | "screen";

export interface RunHeader {
  store: string;
  batch: number;
  mode: RunMode;
  sessions: string[];
  decisionKey: string | null;
  llm: LlmProfile;
  stop?: { baseline: string; threshold: number };
}

export interface RunOutcome<R, S = never> {
  stopped: S | null;
  results: R[];
  failed: Array<{ sessionId: string; error: string }>;
}

type Line<R> = { header: RunHeader } | { result: R } | { failed: { sessionId: string; error: string } };

export function headerMismatch(prior: RunHeader, current: RunHeader): string[] {
  const diffs: string[] = [];
  if (prior.store !== current.store) diffs.push(`store: output has ${prior.store}, this run has ${current.store}`);
  if (prior.batch !== current.batch) diffs.push(`batch: output has ${prior.batch}, this run has ${current.batch}`);
  if (prior.mode !== current.mode) diffs.push(`mode: output has ${prior.mode}, this run has ${current.mode}`);
  if (prior.decisionKey !== current.decisionKey) {
    diffs.push(`decision key: output has ${prior.decisionKey ?? "none"}, this run has ${current.decisionKey ?? "none"}`);
  }
  if (JSON.stringify(prior.llm) !== JSON.stringify(current.llm)) {
    diffs.push(`llm: output has ${JSON.stringify(prior.llm) ?? "none"}, this run has ${JSON.stringify(current.llm)}`);
  }
  if (JSON.stringify(prior.stop) !== JSON.stringify(current.stop)) {
    diffs.push(`stop: output has ${JSON.stringify(prior.stop) ?? "none"}, this run has ${JSON.stringify(current.stop) ?? "none"}`);
  }
  const missing = prior.sessions.filter((s) => !current.sessions.includes(s));
  const added = current.sessions.filter((s) => !prior.sessions.includes(s));
  if (missing.length > 0 || added.length > 0) {
    diffs.push(`sessions: output has ${missing.length} this run lacks (${missing.join(",")}), this run has ${added.length} the output lacks (${added.join(",")})`);
  } else if (prior.sessions.some((s, i) => s !== current.sessions[i])) {
    diffs.push("sessions: same set in a different order");
  }
  return diffs;
}

// Each finished Session is appended to `file` (NDJSON) before the next starts.
// With `resume`, the Sessions already in it are not run again; a failed Session
// is not finished and runs again. A half-written last line is a Session cut off.
// `stopAfter` sees the finished results in Session order after each one, whether run now or
// read from the file, and ends the run with its non-null value; a resumed run therefore stops
// where an uninterrupted one would.
export async function runCheckpointed<R extends { sessionId: string }, S = never>(opts: {
  file: string;
  header: RunHeader;
  resume: boolean;
  run: (sessionId: string) => Promise<R>;
  stopAfter?: (results: R[]) => S | null;
  onResult?: (r: R) => void;
  onFailure?: (sessionId: string, error: string) => void;
}): Promise<RunOutcome<R, S>> {
  const done = new Map<string, R>();
  if (opts.resume) {
    if (!existsSync(opts.file)) throw new Error(`cannot resume: ${opts.file} does not exist`);
    const lines = repairNdjson<Line<R>>(opts.file);
    const first = lines[0];
    if (!first || !("header" in first)) throw new Error(`cannot resume: ${opts.file} has no header line`);
    const diffs = headerMismatch(first.header, opts.header);
    if (diffs.length > 0) throw new Error(`cannot resume ${opts.file}, it differs from this run:\n  ${diffs.join("\n  ")}`);
    for (const line of lines) if ("result" in line) done.set(line.result.sessionId, line.result);
  } else {
    mkdirSync(dirname(opts.file), { recursive: true });
    writeFileAtomic(opts.file, `${JSON.stringify({ header: opts.header })}\n`);
  }

  const failed: RunOutcome<R>["failed"] = [];
  const finished = () => opts.header.sessions.flatMap((s) => (done.has(s) ? [done.get(s)!] : []));
  let stopped: S | null = null;
  for (const sessionId of opts.header.sessions) {
    if (!done.has(sessionId)) {
      try {
        const r = await opts.run(sessionId);
        appendDurable(opts.file, { result: r });
        done.set(sessionId, r);
        opts.onResult?.(r);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failed.push({ sessionId, error });
        appendDurable(opts.file, { failed: { sessionId, error } });
        opts.onFailure?.(sessionId, error);
        continue;
      }
    }
    stopped = opts.stopAfter?.(finished()) ?? null;
    if (stopped) break;
  }
  return { stopped, results: finished(), failed };
}
