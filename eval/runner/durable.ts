import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// A reader sees the old file or the new one, never half of either, across a
// kill or a power cut.
export function writeFileAtomic(path: string, data: string): void {
  const dir = dirname(path);
  const partial = join(dir, `.${basename(path)}.partial`);
  const fd = openSync(partial, "w");
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, path);
  fsyncPath(dir);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2));
}

// A finished unit's row is on disk before the next unit starts. A file shared
// with other writers passes `sharedFile`, so a row never joins another
// writer's unfinished line.
export function appendDurable(path: string, line: unknown, sharedFile = false): void {
  const fd = openSync(path, "a+");
  try {
    const { size } = fstatSync(fd);
    let lead = "";
    if (sharedFile && size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = "\n";
    }
    writeFileSync(fd, `${lead}${JSON.stringify(line)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface Ndjson<T> {
  rows: T[];
  torn: boolean;
  endsInNewline: boolean;
  tornOffset: number;
}

function parseNdjson<T>(path: string, text: string, skipAnyUnparseable = false): Ndjson<T> {
  const lines = text.split("\n");
  const last = lines.length - 1;
  const rows: T[] = [];
  let torn = false;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line) as T);
    } catch (err) {
      if (i !== last && !skipAnyUnparseable) throw new Error(`${path}: line ${i + 1} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
      torn = true;
    }
  });
  return { rows, torn, endsInNewline: text === "" || text.endsWith("\n"), tornOffset: Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)) };
}

// An unparseable last line is a write the kill cut off and is dropped; one
// anywhere else is corruption and throws. Never modifies the file.
export function readNdjson<T>(path: string): Ndjson<T> {
  if (!existsSync(path)) return { rows: [], torn: false, endsInNewline: true, tornOffset: 0 };
  return parseNdjson<T>(path, readFileSync(path, "utf8"));
}

// A file that `appendDurable(…, true)` writers share: a torn fragment becomes a
// middle line once another writer appends after it, so every unparseable line is
// dropped. Never modifies the file, since another writer may be mid-append.
export function readSharedNdjson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return parseNdjson<T>(path, readFileSync(path, "utf8"), true).rows;
}

// Reads the rows and leaves a single-writer file ready to append to: a torn
// tail is cut off and a complete last line gets its newline.
export function repairNdjson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const { rows, torn, endsInNewline, tornOffset } = readNdjson<T>(path);
  if (torn) truncateSync(path, tornOffset);
  else if (!endsInNewline) appendFileSync(path, "\n");
  return rows;
}

export function rewriteNdjson(path: string, rows: unknown[]): void {
  writeFileAtomic(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

// The rows an earlier run of the same --out finished, for a runner that skips
// them on --resume; without it the file starts empty.
export function startNdjson<T>(path: string, resume: boolean): T[] {
  if (resume && existsSync(path)) return repairNdjson<T>(path);
  writeFileAtomic(path, "");
  return [];
}

// The preamble of a runner that scores each question at one or more k. A
// question is finished when its rows cover every k in `ks`; a prior row at any
// other k means the file came from other options.
export function resumeScores<R extends { k: number }>(
  path: string,
  resume: boolean,
  ks: number[],
  keyOf: (row: R) => string,
): { rows: R[]; finished: Set<string> } {
  const prior = startNdjson<R>(path, resume);
  if (prior.some((r) => !ks.includes(r.k))) throw new Error(`${path} was scored at another --k; remove it or pass its own options`);
  const ksSeen = new Map<string, Set<number>>();
  for (const r of prior) ksSeen.set(keyOf(r), (ksSeen.get(keyOf(r)) ?? new Set<number>()).add(r.k));
  const finished = new Set([...ksSeen].filter(([, seen]) => seen.size === new Set(ks).size).map(([key]) => key));
  const rows = prior.filter((r) => finished.has(keyOf(r)));
  if (rows.length < prior.length) rewriteNdjson(path, rows);
  if (finished.size > 0) console.log(`--resume: ${finished.size} questions already scored`);
  return { rows, finished };
}
