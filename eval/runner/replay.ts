import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { deriveAnswerKey } from "./replay-answer-key.js";
import {
  scoreSession,
  summarizeReplay,
  worstCases,
  type Probe,
  type ItemKind,
  type ProbeItem,
  type ProbeKind,
  type SessionScore,
} from "./replay-score.js";
import {
  isMainTranscriptName,
  orderByStart,
  parseTranscript,
  relativeToCwd,
  type ReplaySession,
} from "./replay-transcript.js";
import { daemonCall } from "./daemon-http.js";
import { startSandbox, type EmbeddingMode } from "./sandbox.js";
import { openSplit, selectSplit, type Split } from "./split.js";

const REPO_TMP = resolve(dirname(fileURLToPath(import.meta.url)), "../../tmp");
const SEARCH_LIMIT = 5;
const MAX_TRANSCRIPT_BYTES = 20_000_000;

interface Options {
  projects: string[];
  cap: number;
  minTurns: number;
  maxPrompts: number;
  instance: number;
  embeddings: EmbeddingMode;
  root: string;
  out: string;
  split: Split;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      projects: { type: "string" },
      cap: { type: "string", default: "40" },
      "min-turns": { type: "string", default: "2" },
      "max-prompts": { type: "string", default: "40" },
      instance: { type: "string", default: "9" },
      embeddings: { type: "string", default: "local" },
      root: { type: "string", default: join(homedir(), ".claude/projects") },
      out: { type: "string", default: join(REPO_TMP, "eval-replay") },
      split: { type: "string" },
    },
  });
  const positive = (name: string, raw: string, min = 1): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) {
      console.error(`--${name} must be an integer >= ${min}, got: ${raw}`);
      process.exit(2);
    }
    return n;
  };
  const projects = (values.projects ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (projects.length === 0) {
    console.error("--projects is required: comma-separated directory names under ~/.claude/projects");
    process.exit(2);
  }
  // The worst-cases file quotes private transcripts, so output never leaves tmp/.
  const out = resolve(values.out as string);
  if (relative(REPO_TMP, out).startsWith("..")) {
    console.error(`--out must be under ${REPO_TMP}, got: ${out}`);
    process.exit(2);
  }
  if (values.embeddings !== "local" && values.embeddings !== "none") {
    console.error(`--embeddings must be local or none, got: ${values.embeddings}`);
    process.exit(2);
  }
  return {
    projects,
    cap: positive("cap", values.cap as string),
    minTurns: positive("min-turns", values["min-turns"] as string),
    maxPrompts: positive("max-prompts", values["max-prompts"] as string),
    instance: positive("instance", values.instance as string),
    embeddings: values.embeddings,
    root: resolve(values.root as string),
    out,
    split: openSplit(values.split, "replay"),
  };
}

interface Loaded {
  sessions: ReplaySession[];
  perDirectory: Record<string, { files: number; skippedLarge: number }>;
  perProject: Record<string, { replayable: number; replayed: number }>;
}

function mainCheckoutName(dir: string): string | undefined {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return basename(common) === ".git" ? basename(dirname(common)) : undefined;
  } catch {
    return undefined;
  }
}

// Mirrors the live hooks' resolveProject: every worktree of a repo files
// under its main checkout's name. A deleted worktree resolves from its
// nearest surviving ancestor inside the repo, or from the Orca layout
// <...>/workspaces/<repo>/<worktree>; anything else keeps the importer's name.
function repoProject(cwd: string, importerName: string): string {
  let dir = cwd;
  while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
  return mainCheckoutName(dir) ?? cwd.match(/\/workspaces\/([^/]+)\/[^/]+/)?.[1] ?? importerName;
}

function loadSessions(opts: Options): Loaded {
  const byProject = new Map<string, ReplaySession[]>();
  const perDirectory: Loaded["perDirectory"] = {};
  const projectByCwd = new Map<string, string>();
  const seen = new Set<string>();
  for (const dir of opts.projects) {
    const path = join(opts.root, dir);
    if (!existsSync(path)) {
      console.error(`no such project directory: ${path}`);
      process.exit(2);
    }
    const files = readdirSync(path).filter(isMainTranscriptName);
    const stats = { files: files.length, skippedLarge: 0 };
    for (const name of files) {
      const file = join(path, name);
      if (statSync(file).size > MAX_TRANSCRIPT_BYTES) {
        stats.skippedLarge++;
        continue;
      }
      const session = parseTranscript(readFileSync(file, "utf8"), file);
      if (!session || session.userTurns.length < opts.minTurns || seen.has(session.id)) continue;
      seen.add(session.id);
      if (!projectByCwd.has(session.cwd)) projectByCwd.set(session.cwd, repoProject(session.cwd, session.project));
      session.project = projectByCwd.get(session.cwd)!;
      byProject.set(session.project, [...(byProject.get(session.project) ?? []), session]);
    }
    perDirectory[dir] = stats;
  }
  const picked: ReplaySession[] = [];
  const perProject: Loaded["perProject"] = {};
  for (const [project, sessions] of byProject) {
    const chosen = orderByStart(sessions).slice(0, opts.cap);
    perProject[project] = { replayable: sessions.length, replayed: chosen.length };
    picked.push(...chosen);
  }
  return { sessions: orderByStart(picked), perDirectory, perProject };
}

const post = <T>(baseUrl: string, path: string, body: unknown) => daemonCall<T>(baseUrl, path, { body });
const get = <T>(baseUrl: string, path: string) => daemonCall<T>(baseUrl, path);

interface ObsRow {
  id: string;
  title?: string;
  subtitle?: string;
  narrative?: string;
  facts?: string[];
  files?: string[];
}

interface ItemRef {
  kind: ItemKind;
  id: string;
  files?: string[];
}

interface InjectionRecordRow {
  source: string;
  at: string;
  injected: ItemRef[];
}

// Lessons and Memories by id, which carry their own project and text.
type Extra = Map<string, { project?: string; text: string }>;

interface Resolver {
  observations: Map<string, { session: ReplaySession; row: ObsRow }>;
  sessions: Map<string, ReplaySession>;
}

function obsText(row: ObsRow): string {
  return [row.title, row.narrative, ...(row.facts ?? [])].filter(Boolean).join("\n");
}

function itemFor(ref: ItemRef, resolver: Resolver, extra: Extra): ProbeItem {
  const key = `${ref.kind}:${ref.id}`;
  const obs = resolver.observations.get(ref.id);
  if (obs) {
    const files = (obs.row.files ?? ref.files ?? []).flatMap((f) => relativeToCwd(f, obs.session.cwd) ?? []);
    return { ref: key, kind: ref.kind, sessionId: obs.session.id, project: obs.session.project, files, text: obsText(obs.row) };
  }
  const session = resolver.sessions.get(ref.id);
  if (ref.kind === "summary" && session) {
    const files = (ref.files ?? []).flatMap((f) => relativeToCwd(f, session.cwd) ?? []);
    return { ref: key, kind: ref.kind, sessionId: session.id, project: session.project, files, text: session.userTurns[0]?.text ?? "" };
  }
  const known = extra.get(ref.id);
  return { ref: key, kind: ref.kind, project: known?.project, files: [], text: known?.text ?? "" };
}

// Lessons and Memories carry their own project and text; they are fetched
// once per Session that needs them, because import adds Lessons as it goes.
async function lessonsAndMemories(baseUrl: string): Promise<Extra> {
  const out: Extra = new Map();
  const lessons = await get<{ lessons?: Array<{ id: string; content: string; project?: string }> }>(baseUrl, "lessons?limit=1000").catch(() => null);
  for (const l of lessons?.body.lessons ?? []) out.set(l.id, { project: l.project, text: l.content });
  const memories = await get<{ memories?: Array<{ id: string; title?: string; content?: string; project?: string }> }>(baseUrl, "memories?limit=1000").catch(() => null);
  for (const m of memories?.body.memories ?? []) out.set(m.id, { project: m.project, text: [m.title, m.content].filter(Boolean).join("\n") });
  return out;
}

interface SearchRow {
  obsId?: string;
  id?: string;
  sessionId?: string;
}

function storeBytes(sqlitePath: string): number {
  return [sqlitePath, `${sqlitePath}-wal`].reduce((n, p) => n + (existsSync(p) ? statSync(p).size : 0), 0);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function probeSession(
  baseUrl: string,
  session: ReplaySession,
  maxPrompts: number,
  resolver: Resolver,
): Promise<Probe[]> {
  const probes: Probe[] = [];
  const attempt = async (kind: ProbeKind, turn: number, run: () => Promise<Omit<Probe, "kind" | "turn">>) => {
    try {
      probes.push({ kind, turn, ...(await run()) });
    } catch (err) {
      console.warn(`  ${kind} probe failed at turn ${turn}: ${errorMessage(err)}`);
      probes.push({ kind, turn, latencyMs: 0, chars: 0, items: [], failed: true });
    }
  };
  const injection = (path: string, body: unknown) => async () => {
    const { body: res, ms } = await post<{ context?: string }>(baseUrl, path, body);
    return { latencyMs: ms, chars: res.context?.length ?? 0, items: [] };
  };

  await attempt("session-start", 0, injection("session/start", { sessionId: session.id, project: session.project, cwd: session.cwd }));
  for (const turn of session.userTurns.slice(0, maxPrompts)) {
    await attempt("prompt-context", turn.turn, injection("prompt-context", { sessionId: session.id, prompt: turn.text, project: session.project }));
    await attempt("search", turn.turn, async () => {
      const { body, ms } = await post<{ results?: SearchRow[] }>(baseUrl, "smart-search", {
        query: turn.text,
        limit: SEARCH_LIMIT,
        project: session.project,
      });
      const items = (body.results ?? []).flatMap((r) => {
        const id = r.obsId ?? r.id;
        return id ? [itemFor({ kind: "observation", id }, resolver, new Map())] : [];
      });
      return { latencyMs: ms, chars: items.reduce((n, i) => n + i.text.length, 0), items };
    });
  }

  // The daemon records each Injection as it answers; read the records back
  // in order to learn exactly which Memories each probe delivered.
  await new Promise((r) => setTimeout(r, 100));
  const { body } = await get<{ injections?: InjectionRecordRow[] }>(baseUrl, `injections?sessionId=${encodeURIComponent(session.id)}`);
  const records = [...(body.injections ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  const extra = await lessonsAndMemories(baseUrl);
  // Records are paired with probes per source: a session-start record exists
  // only when the daemon runs with injection on, so position across sources
  // would shift every later probe onto the wrong record.
  for (const [kind, source] of [["session-start", "session-start"], ["prompt-context", "prompt-submit"]] as const) {
    const ofKind = probes.filter((p) => p.kind === kind && !p.failed);
    const ofSource = records.filter((r) => r.source === source);
    if (ofKind.length !== ofSource.length) {
      console.warn(`  ${source} injection records (${ofSource.length}) do not match probes (${ofKind.length})`);
    }
    ofKind.forEach((probe, i) => {
      probe.items = (ofSource[i]?.injected ?? []).map((ref) => itemFor(ref, resolver, extra));
    });
  }
  return probes;
}

function worstCasesMarkdown(scores: SessionScore[]): string {
  const cases = worstCases(scores);
  const lines = [
    "# Replay worst cases",
    "",
    "Quotes the Operator's own transcripts. Lives under tmp/ and is never committed.",
    "",
  ];
  for (const category of ["miss", "noise", "leak"] as const) {
    lines.push(`## ${category}`, "");
    cases
      .filter((c) => c.category === category)
      .forEach((c, i) => lines.push(`${i + 1}. Session ${c.sessionId}, turn ${c.turn}: ${c.detail.replace(/\s+/g, " ")}`));
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const opts = parseOptions();
  const { sessions, perDirectory, perProject } = loadSessions(opts);
  console.log(`replaying ${sessions.length} Sessions from ${Object.keys(perProject).length} projects (${opts.projects.length} directories), instance ${opts.instance}`);
  mkdirSync(opts.out, { recursive: true });
  const ndjson = join(opts.out, "scores.ndjson");
  writeFileSync(ndjson, "");

  // The Operator's live daemon injects; without this the sandbox's session
  // start writes no Injection record and delivers nothing to score.
  process.env.AGENTMEMORY_INJECT_CONTEXT ??= "true";
  const sandbox = await startSandbox({ instance: opts.instance, embeddings: opts.embeddings });
  const resolver: Resolver = { observations: new Map(), sessions: new Map() };
  // Every Session is imported whichever split runs, but only the split's
  // Sessions are probed, and probing writes Session and Injection rows, so the
  // dev and holdout stores differ. Compare a run only with one of its own split.
  const scored = new Set(selectSplit("replay", sessions, opts.split, (s) => s.id, (s) => s.project).map((s) => s.id));
  const ingested: ReplaySession[] = [];
  const scores: SessionScore[] = [];
  const bytesStart = storeBytes(sandbox.sqlitePath);
  const t0 = Date.now();
  try {
    for (const [i, session] of sessions.entries()) {
      const probeStart = Date.now();
      let score: SessionScore | undefined;
      if (scored.has(session.id)) {
        const probes = await probeSession(sandbox.baseUrl, session, opts.maxPrompts, resolver);
        score = scoreSession(session, deriveAnswerKey(session, ingested), probes);
        scores.push(score);
        appendFileSync(ndjson, `${JSON.stringify(score)}\n`);
      }

      const importStart = Date.now();
      try {
        await post(sandbox.baseUrl, "replay/import-jsonl", { path: session.sourcePath, project: session.project });
        const { body } = await get<{ observations?: ObsRow[] }>(sandbox.baseUrl, `observations?sessionId=${encodeURIComponent(session.id)}`);
        for (const row of body.observations ?? []) resolver.observations.set(row.id, { session, row });
        resolver.sessions.set(session.id, session);
        ingested.push(session);
      } catch (err) {
        console.warn(`  import failed: ${errorMessage(err)}`);
      }
      const scoredLine = score
        ? `turns=${score.turns} key=${score.outcomes.length} injected=${score.items.length} ` +
          `used=${score.items.filter((x) => x.used).length} hit=${score.outcomes.filter((o) => o.injected).length} `
        : "unscored ";
      console.log(
        `[${i + 1}/${sessions.length}] ${session.id.slice(0, 8)} ${scoredLine}probe=${Math.round((importStart - probeStart) / 1000)}s ` +
          `import=${Math.round((Date.now() - importStart) / 1000)}s total=${Math.round((Date.now() - t0) / 1000)}s`,
      );
    }
    const meta = { storeBytesStart: bytesStart, storeBytesEnd: storeBytes(sandbox.sqlitePath) };
    const summary = summarizeReplay(scores, meta);
    const run = {
      date: new Date().toISOString(),
      options: { ...opts, root: undefined, out: undefined },
      providers: {
        embeddings: opts.embeddings === "none" ? "none" : (process.env.EMBEDDING_PROVIDER ?? "local"),
        embeddingModel: opts.embeddings === "none" ? null : (process.env.OPENAI_EMBEDDING_MODEL ?? null),
        embeddingDimensions: process.env.OPENAI_EMBEDDING_DIMENSIONS ?? null,
        rerank: process.env.RERANK_ENABLED ?? "off",
        llm: "none",
      },
      directories: perDirectory,
      projects: perProject,
      minutes: (Date.now() - t0) / 60_000,
    };
    writeFileSync(join(opts.out, "summary.json"), JSON.stringify({ run, summary }, null, 2));
    writeFileSync(join(opts.out, "worst-cases.md"), worstCasesMarkdown(scores));
    console.log(JSON.stringify({ run: run.providers, minutes: run.minutes, summary }, null, 2));
    console.log(`\nwrote ${opts.out}/{summary.json,scores.ndjson,worst-cases.md}`);
  } finally {
    await sandbox.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
