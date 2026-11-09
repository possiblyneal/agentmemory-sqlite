import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { hydrateProcessEnvFromFile, loadConfig, loadFallbackConfig } from "../../src/config.js";
import { createFallbackProvider, createProvider } from "../../src/providers/index.js";
import { KV } from "../../src/state/schema.js";
import type { CompressedObservation, MemoryProvider, Session } from "../../src/types.js";
import { createJudge, openVerdictCache } from "./decision-judge.js";
import { readDecisionKey } from "./decision-key.js";
import { DECISION_VERDICTS_PATH, providerComplete } from "./decision-llm.js";
import { runCheckpointed, type RunHeader } from "./fold-drift-resume.js";
import { armCounts, baselineSessions, orderByBaseline, stopLine, stopReport, stopState, type BaselineSession, type LabelledResult, type StopState } from "./fold-drift-stop.js";
import { DECISION_LABELS, SCREEN_MODE_TAG, measureFoldDrift, refuseRescoreMismatch, rescoreFoldDrift, screenOnePass, screenRow, screenTotal, type DecisionLabel, type FoldDriftResult, type Judging, type LlmProfile, type RescoreResult, type ScreenResult, type StoredFoldDrift, type StoredRescore } from "./fold-drift-core.js";

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
      "decision-key": { type: "string" },
      "one-pass": { type: "boolean", default: false },
      resume: { type: "string" },
      rescore: { type: "string" },
      baseline: { type: "string" },
      threshold: { type: "string", default: "10" },
    },
  });
  const batch = Math.max(1, parseInt(values.batch!, 10) || 50);
  const ids = values.sessions ? values.sessions.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (values.rescore) return rescore(values.rescore, ids, batch, values.store, values["decision-key"]);
  if (!values.store || (!values.sessions && !values.longest)) {
    throw new Error("usage: eval:fold-drift --store <sqlite> (--sessions id,... | --longest N) [--batch N] [--decision-key <path>] [--one-pass] [--resume <run.ndjson>] [--baseline <output.json> [--threshold N]]\n       eval:fold-drift --rescore <output.json> --sessions id,... --decision-key <path> [--batch N] [--store <sqlite>]");
  }

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

  const judging: Judging = {
    judge: createJudge(providerComplete(), openVerdictCache(DECISION_VERDICTS_PATH)),
    key: values["decision-key"] ? readDecisionKey(values["decision-key"]).decisions : [],
  };
  const screening = values["one-pass"];
  const threshold = parseInt(values.threshold!, 10);
  if (!(threshold >= 1)) throw new Error("--threshold must be a positive integer");
  const ordered = values.baseline
    ? await baselineOrder(values.baseline, [...sessions.keys()], { batch, store: values.store, screening, judging, keyPath: values["decision-key"] })
    : null;
  const mode = screening ? "screen" : "full";
  const header: RunHeader = {
    store: values.store,
    batch,
    mode,
    sessions: ordered ? ordered.map((b) => b.sessionId) : [...sessions.keys()],
    decisionKey: values["decision-key"] ?? null,
    llm: llmProfile(),
    ...(values.baseline ? { stop: { baseline: values.baseline, threshold } } : {}),
  };
  const stopAfter = ordered
    ? (finished: LabelledResult[]) => {
        const state = stopState(ordered, armCounts(finished, mode), threshold);
        return state.stop ? state : null;
      }
    : undefined;
  const earlyStop = (results: LabelledResult[], stopped: StopState | null, failed: Array<{ sessionId: string }>) => {
    if (!ordered) return null;
    const state = stopped ?? stopState(ordered, armCounts(results, mode), threshold);
    return stopReport(state, stopped !== null, failed.map((f) => f.sessionId));
  };
  const stopFields = (report: ReturnType<typeof earlyStop>) => {
    if (!report) return {};
    console.log(stopLine(report));
    return { ...report, baseline: values.baseline };
  };
  const stem = values.resume
    ? values.resume.replace(/\.ndjson$/, "")
    : join(OUT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}${screening ? "-screen" : ""}`);
  const checkpoint = `${stem}.ndjson`;
  const project = (id: string) => projects.get(id) ?? "unknown";
  if (screening) {
    const { results, failed, stopped } = await runCheckpointed<ScreenResult, StopState>({
      file: checkpoint,
      header,
      resume: !!values.resume,
      stopAfter,
      run: (id) => screenOnePass(provider, sessions.get(id)!, { sessionId: id, project: project(id), batch }, judging),
      onResult: (r) => console.log(screenRow(r)),
      onFailure: (id, error) => console.log(`${SCREEN_MODE_TAG} ${id} failed: ${error}`),
    });
    console.log(screenTotal(results));
    writeFileSync(`${stem}.json`, JSON.stringify({ mode: "screen", store: values.store, batch, llm: header.llm, ...stopFields(earlyStop(results, stopped, failed)), sessions: results, failed }, null, 2));
    console.log(`wrote ${stem}.json`);
    return;
  }
  const { results, failed, stopped } = await runCheckpointed<FoldDriftResult, StopState>({
    file: checkpoint,
    header,
    resume: !!values.resume,
    stopAfter,
    run: (id) => measureFoldDrift(provider, sessions.get(id)!, { sessionId: id, project: project(id), batch }, judging),
    onResult: (r) => console.log(row(r)),
    onFailure: (id, error) => console.log(`${id} failed: ${error}`),
  });

  const total = results.reduce(
    (t, r) => ({
      full: t.full + r.full,
      folded: t.folded + r.folded,
      missingExact: t.missingExact + r.missingExact,
      missingLoose: t.missingLoose + r.missingLoose,
      missingJudged: t.missingJudged + (r.missingJudged ?? 0),
      droppedExact: t.droppedExact + r.droppedExact,
      droppedLoose: t.droppedLoose + r.droppedLoose,
      fallbackDroppedExact: t.fallbackDroppedExact + r.fallbackDroppedExact,
      fallbackDroppedLoose: t.fallbackDroppedLoose + r.fallbackDroppedLoose,
    }),
    { full: 0, folded: 0, missingExact: 0, missingLoose: 0, missingJudged: 0, droppedExact: 0, droppedLoose: 0, fallbackDroppedExact: 0, fallbackDroppedLoose: 0 },
  );
  const labelTotal = labelCounts(results.flatMap((r) => r.labels ?? []));
  console.log(`total sessions=${results.length} full=${total.full} folded=${total.folded} missing(exact)=${total.missingExact} missing(jaccard>=0.5)=${total.missingLoose} missing(judged)=${total.missingJudged}${labelText(labelTotal)} dropped-by-folds(exact)=${total.droppedExact} dropped-by-folds(jaccard>=0.5)=${total.droppedLoose} dropped-by-fallbacks(exact)=${total.fallbackDroppedExact} dropped-by-fallbacks(jaccard>=0.5)=${total.fallbackDroppedLoose}`);

  writeFileSync(`${stem}.json`, JSON.stringify({ store: values.store, batch, llm: header.llm, total, labelTotal, ...stopFields(earlyStop(results, stopped, failed)), sessions: results, failed }, null, 2));
  console.log(`wrote ${stem}.json`);
}

// The baseline's per-Session never-captured counts for the selected Sessions, most first. A full
// baseline output is scored against the key (cached verdicts); a --rescore output is used as it is,
// after the same refusal plus a check that it was scored against this run's key.
// A screen is compared with the baseline's not-in-one-pass count, a full run with its in-neither.
async function baselineOrder(
  file: string,
  selected: string[],
  o: { batch: number; store: string; screening: boolean; judging: Judging; keyPath: string | undefined },
): Promise<BaselineSession[]> {
  if (!o.keyPath) throw new Error("--baseline needs --decision-key: the arm's counts come from the key");
  const stored = JSON.parse(readFileSync(file, "utf8")) as StoredFoldDrift & { mode?: string; decisionKey?: string };
  const req = { sessionIds: selected, batch: o.batch, store: o.store, llm: llmProfile() };
  let scored: RescoreResult["sessions"];
  if (stored.mode === "rescore") {
    scored = refuseRescoreMismatch(stored as unknown as StoredRescore, req, o.keyPath).sessions;
  } else {
    scored = (await rescoreFoldDrift(stored, req, o.judging)).sessions;
  }
  const held = new Set(scored.map((s) => s.sessionId));
  const absent = selected.filter((id) => !held.has(id));
  if (absent.length > 0) throw new Error(`Sessions not in the baseline: ${absent.join(", ")}`);
  const wanted = new Set(selected);
  return orderByBaseline(baselineSessions(scored.filter((s) => wanted.has(s.sessionId)), o.screening ? "screen" : "full"));
}

// The model and endpoint a run summarized on (the broker profile is its model name), recorded so a
// later re-score can refuse a baseline made on other settings. Credentials in the URL are dropped.
function llmProfile(): LlmProfile {
  const url = new URL(process.env.OPENAI_BASE_URL ?? "http://unset");
  return { model: process.env.OPENAI_MODEL ?? "unset", baseUrl: `${url.origin}${url.pathname}` };
}

// Judges the key against a previous output's stored lists; no summarize call is made.
async function rescore(file: string, ids: string[], batch: number, store: string | undefined, keyPath: string | undefined): Promise<void> {
  if (ids.length === 0 || !keyPath) {
    throw new Error("usage: eval:fold-drift --rescore <output.json> --sessions id,... --decision-key <path> [--batch N] [--store <sqlite>]");
  }
  const stored = JSON.parse(readFileSync(file, "utf8")) as StoredFoldDrift;
  hydrateProcessEnvFromFile();
  const judging: Judging = {
    judge: createJudge(providerComplete(), openVerdictCache(DECISION_VERDICTS_PATH)),
    key: readDecisionKey(keyPath).decisions,
  };
  const result = await rescoreFoldDrift(stored, { sessionIds: ids, batch, store, llm: llmProfile() }, judging);
  for (const s of result.sessions) console.log(rescoreRow(s.sessionId, s));
  console.log(rescoreRow(`total sessions=${result.sessions.length}`, result.total));
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `rescore-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const output: StoredRescore = { mode: "rescore", from: file, store: stored.store, batch, llm: stored.llm, decisionKey: keyPath, ...result };
  writeFileSync(out, JSON.stringify(output, null, 2));
  console.log(`wrote ${out}`);
}

function rescoreRow(name: string, c: RescoreResult["total"]): string {
  return `${name} key=${c.keyDecisions} in-one-pass=${c.inOnePass} in-folded=${c.inFolded} never-captured=${c.neverCaptured}`;
}

function labelCounts(labels: Array<{ label: DecisionLabel }>): Record<DecisionLabel, number> {
  const counts = Object.fromEntries(DECISION_LABELS.map((l) => [l, 0])) as Record<DecisionLabel, number>;
  for (const { label } of labels) counts[label]++;
  return counts;
}

function labelText(counts: Record<DecisionLabel, number>): string {
  const n = DECISION_LABELS.reduce((sum, l) => sum + counts[l], 0);
  return n === 0 ? "" : ` key:${DECISION_LABELS.map((l) => `${l}=${counts[l]}`).join(" key:")}`;
}

function row(r: FoldDriftResult): string {
  return `${r.sessionId} obs=${r.observations} full=${r.full} folded=${r.folded} folds=${r.folds} fallbacks=${r.fallbacks} missing(exact)=${r.missingExact} missing(jaccard>=0.5)=${r.missingLoose} missing(judged)=${r.missingJudged}${labelText(labelCounts(r.labels ?? []))} dropped-by-folds(exact)=${r.droppedExact} dropped-by-folds(jaccard>=0.5)=${r.droppedLoose} dropped-by-fallbacks(exact)=${r.fallbackDroppedExact} dropped-by-fallbacks(jaccard>=0.5)=${r.fallbackDroppedLoose}`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
