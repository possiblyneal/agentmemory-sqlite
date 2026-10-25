import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { hydrateProcessEnvFromFile, loadConfig, loadFallbackConfig } from "../../src/config.js";
import { createFallbackProvider, createProvider } from "../../src/providers/index.js";
import { KV } from "../../src/state/schema.js";
import type { CompressedObservation, Session } from "../../src/types.js";
import { measureFoldDrift, type FoldDriftResult } from "./fold-drift-core.js";

const OUT_DIR = "tmp/eval-fold-drift";

// A checkpoint is a closed copy read once, before any daemon exists, so it is
// read straight from SqliteState's kv table rather than booting an Engine on it.
function readScope<T>(db: DatabaseSync, scope: string): T[] {
  const rows = db
    .prepare("SELECT value FROM kv WHERE scope = ? ORDER BY seq")
    .all(scope) as Array<{ value: string }>;
  return rows.map((r) => JSON.parse(r.value) as T);
}

function pickSessions(db: DatabaseSync, ids: string[], longest: number): Map<string, CompressedObservation[]> {
  const chosen = ids.length > 0 ? ids : readScope<Session>(db, KV.sessions).map((s) => s.id);
  const bySession = new Map<string, CompressedObservation[]>();
  for (const id of chosen) {
    const obs = readScope<CompressedObservation>(db, KV.observations(id))
      .filter((o) => typeof o.title === "string" && o.title.length > 0)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (obs.length > 0) bySession.set(id, obs);
  }
  if (ids.length > 0) return bySession;
  const top = [...bySession].sort((a, b) => b[1].length - a[1].length).slice(0, longest);
  return new Map(top);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      store: { type: "string" },
      sessions: { type: "string" },
      longest: { type: "string" },
      batch: { type: "string", default: "50" },
    },
  });
  if (!values.store || (!values.sessions && !values.longest)) {
    throw new Error("usage: eval:fold-drift --store <sqlite> (--sessions id,... | --longest N) [--batch N]");
  }
  const batch = Math.max(1, parseInt(values.batch!, 10) || 50);
  const ids = values.sessions ? values.sessions.split(",").map((s) => s.trim()).filter(Boolean) : [];

  hydrateProcessEnvFromFile();
  const config = loadConfig();
  const fallback = loadFallbackConfig();
  const provider =
    fallback.providers.length > 0
      ? createFallbackProvider(config.provider, fallback)
      : createProvider(config.provider);

  const db = new DatabaseSync(values.store, { readOnly: true });
  const sessions = pickSessions(db, ids, parseInt(values.longest ?? "0", 10) || 0);
  const projects = new Map(readScope<Session>(db, KV.sessions).map((s) => [s.id, s.project]));
  db.close();

  const results: FoldDriftResult[] = [];
  const failed: Array<{ sessionId: string; error: string }> = [];
  for (const [sessionId, observations] of sessions) {
    try {
      const r = await measureFoldDrift(provider, observations, {
        sessionId,
        project: projects.get(sessionId) ?? "unknown",
        batch,
      });
      results.push(r);
      console.log(row(r));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ sessionId, error });
      console.log(`${sessionId} failed: ${error}`);
    }
  }

  const total = results.reduce(
    (t, r) => ({
      full: t.full + r.full,
      folded: t.folded + r.folded,
      missingExact: t.missingExact + r.missingExact,
      missingLoose: t.missingLoose + r.missingLoose,
    }),
    { full: 0, folded: 0, missingExact: 0, missingLoose: 0 },
  );
  console.log(`total sessions=${results.length} full=${total.full} folded=${total.folded} missing(exact)=${total.missingExact} missing(jaccard>=0.5)=${total.missingLoose}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ store: values.store, batch, total, sessions: results, failed }, null, 2));
  console.log(`wrote ${file}`);
}

function row(r: FoldDriftResult): string {
  return `${r.sessionId} obs=${r.observations} full=${r.full} folded=${r.folded} folds=${r.folds} fallbacks=${r.fallbacks} missing(exact)=${r.missingExact} missing(jaccard>=0.5)=${r.missingLoose}`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
