import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { ReplaySession } from "./replay-transcript.js";

// A copy of the store as it stands just before a scored Session would be
// probed, so the probing pass can run later, and more than once, without
// paying the import (and its LLM calls) again.
export interface Checkpoint {
  sessionId: string;
  file: string;
  ingested: string[];
}

export const MANIFEST = "manifest.json";

export async function saveCheckpoint(
  sqlitePath: string,
  dir: string,
  index: number,
  sessionId: string,
  ingested: ReplaySession[],
): Promise<Checkpoint> {
  const file = `${String(index).padStart(3, "0")}-${sessionId}.sqlite`;
  // VACUUM INTO, not sqlite.backup, which needs Node 22.16 against the 22.13 floor.
  // It refuses an existing file, which a pass interrupted mid-write leaves
  // behind unlisted for the resume to write again.
  rmSync(join(dir, file), { force: true });
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(join(dir, file));
  } finally {
    db.close();
  }
  return { sessionId, file, ingested: ingested.map((s) => s.id) };
}

export interface SavePass {
  checkpoints: Checkpoint[];
  ingested: ReplaySession[];
  resumeAt: number;
  seed?: string;
}

export function openSavePass(
  checkpointDir: string,
  resume: boolean,
  sessions: ReplaySession[],
  scored: Set<string>,
): SavePass {
  const manifestPath = join(checkpointDir, MANIFEST);
  if (!resume) {
    // A save pass takes hours of LLM time; never let a rerun mix its stores
    // with, or silently stand behind, an earlier pass's manifest.
    if (existsSync(manifestPath)) throw new Error(`${checkpointDir} already holds a save pass; pass a fresh --out, or --resume`);
    mkdirSync(checkpointDir, { recursive: true });
    return { checkpoints: [], ingested: [], resumeAt: 0 };
  }
  // An interrupted save pass restarts from its last checkpoint: that store
  // holds every Session ingested before it, so only the rest are replayed.
  if (!existsSync(manifestPath)) throw new Error(`${checkpointDir} holds no save pass to resume`);
  if (existsSync(join(checkpointDir, "run.json"))) throw new Error(`${checkpointDir} holds a finished save pass; nothing to resume`);
  const checkpoints = JSON.parse(readFileSync(manifestPath, "utf8")) as Checkpoint[];
  const last = checkpoints.at(-1);
  if (!last) throw new Error(`${manifestPath} lists no checkpoint to resume from`);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const resumeAt = sessions.findIndex((s) => s.id === last.sessionId);
  // The same options load the same Sessions in the same order and split, so
  // the last checkpoint sits at the index its file name records, and every
  // Session it ingested comes before it.
  const before = new Set(sessions.slice(0, Math.max(resumeAt, 0)).map((s) => s.id));
  const sameCorpus =
    resumeAt === Number.parseInt(last.file, 10) &&
    last.ingested.every((id) => before.has(id)) &&
    checkpoints.every((c) => scored.has(c.sessionId));
  if (!sameCorpus) {
    throw new Error(`${manifestPath} was saved from other Sessions than these options load; pass the save pass's own options`);
  }
  const ingested = last.ingested.map((id) => byId.get(id)!);
  console.log(`--resume: from ${last.file}, ${ingested.length} Sessions already ingested`);
  return { checkpoints, ingested, resumeAt, seed: join(checkpointDir, last.file) };
}
