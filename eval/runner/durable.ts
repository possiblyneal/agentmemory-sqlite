import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, truncateSync, writeSync } from "node:fs";
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
    writeSync(fd, data);
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

// A finished unit's row is on disk before the next unit starts.
export function appendDurable(path: string, line: unknown): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(line)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface Ndjson<T> {
  rows: T[];
  torn: boolean;
}

// An unparseable last line is a write the kill cut off and is dropped; one
// anywhere else is corruption and throws.
export function readNdjson<T>(path: string): Ndjson<T> {
  if (!existsSync(path)) return { rows: [], torn: false };
  const lines = readFileSync(path, "utf8").split("\n");
  const last = lines.length - 1;
  const rows: T[] = [];
  let torn = false;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line) as T);
    } catch (err) {
      if (i !== last) throw new Error(`${path}: line ${i + 1} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
      torn = true;
    }
  });
  return { rows, torn };
}

// Reads the rows and leaves the file ready to append to: a torn tail is cut
// off and a complete last line gets its newline.
export function repairNdjson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const { rows, torn } = readNdjson<T>(path);
  const text = readFileSync(path, "utf8");
  if (torn) truncateSync(path, Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)));
  else if (text !== "" && !text.endsWith("\n")) appendFileSync(path, "\n");
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
