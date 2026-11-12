import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// #389: a Lesson the daemon could not receive is kept on disk and replayed when
// the shim next reaches it. Each save is its own file, so the several shims of
// concurrent Sessions append and claim entries with atomic renames, no lock.
const MAX_QUEUE_BYTES = 256 * 1024;
const STALE_CLAIM_MS = 60_000;
const ENTRY_SUFFIX = ".json";
const CLAIM_MARK = ".claimed-";

export interface QueuedLesson {
  queuedAt: string;
  arguments: Record<string, unknown>;
}

// Orders two saves of one shim within the same millisecond.
let sequence = 0;

export type ReplayOutcome = "saved" | "rejected" | "retry";

export function lessonQueueDir(): string {
  return join(homedir(), ".agentmemory", "lesson-queue");
}

function entryNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function queuedBytes(dir: string): number {
  let total = 0;
  for (const name of entryNames(dir)) {
    try {
      total += statSync(join(dir, name)).size;
    } catch {}
  }
  return total;
}

/** Returns false when the queue is full or cannot be written. */
export function queueLesson(args: Record<string, unknown>): boolean {
  const dir = lessonQueueDir();
  const entry: QueuedLesson = { queuedAt: new Date().toISOString(), arguments: args };
  const text = JSON.stringify(entry);
  try {
    mkdirSync(dir, { recursive: true });
    if (queuedBytes(dir) + Buffer.byteLength(text) > MAX_QUEUE_BYTES) return false;
    const name = `${String(Date.now()).padStart(15, "0")}-${String(sequence++).padStart(6, "0")}-${process.pid}-${randomBytes(4).toString("hex")}`;
    const tmp = join(dir, `.${name}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, join(dir, name + ENTRY_SUFFIX));
    return true;
  } catch {
    return false;
  }
}

// A claim names its time, since a rename keeps the entry's own mtime. One older
// than STALE_CLAIM_MS belongs to a shim that died mid-replay.
function claimable(name: string, now: number): boolean {
  if (name.endsWith(ENTRY_SUFFIX)) return true;
  const mark = name.indexOf(CLAIM_MARK);
  if (mark === -1) return false;
  const claimedAt = Number(name.slice(name.lastIndexOf("-") + 1));
  return Number.isFinite(claimedAt) && now - claimedAt > STALE_CLAIM_MS;
}

function originalName(name: string): string {
  const mark = name.indexOf(CLAIM_MARK);
  return mark === -1 ? name : name.slice(0, mark);
}

/**
 * Replays queued saves oldest first through `send`, which reports how the
 * daemon answered. A saved or rejected entry is removed; a retry stops the
 * replay and leaves that entry and the rest queued.
 */
export async function replayLessonQueue(
  send: (entry: QueuedLesson) => Promise<ReplayOutcome>,
  log: (line: string) => void,
): Promise<void> {
  const dir = lessonQueueDir();
  const now = Date.now();
  for (const name of entryNames(dir)) {
    if (!claimable(name, now)) continue;
    const source = join(dir, name);
    const claimed = join(dir, `${originalName(name)}${CLAIM_MARK}${process.pid}-${Date.now()}`);
    try {
      renameSync(source, claimed);
    } catch {
      continue;
    }
    let entry: QueuedLesson;
    try {
      entry = JSON.parse(readFileSync(claimed, "utf-8")) as QueuedLesson;
    } catch {
      log(`dropped unreadable queued Lesson ${name}`);
      rmSync(claimed, { force: true });
      continue;
    }
    if ((await send(entry)) === "retry") {
      renameSync(claimed, join(dir, originalName(name)));
      return;
    }
    rmSync(claimed, { force: true });
  }
}
