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
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { deriveAnswerKey } from "./replay-answer-key.js";
import {
  scoreSession,
  summarize,
  worstCases,
  type Probe,
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
import { startSandbox, type EmbeddingMode } from "./sandbox.js";

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
      out: { type: "string", default: "tmp/eval-replay" },
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
    out: resolve(values.out as string),
  };
}

interface Loaded {
  sessions: ReplaySession[];
  perProject: Record<string, { files: number; replayable: number; replayed: number; skippedLarge: number }>;
}

function loadSessions(opts: Options): Loaded {
  const picked: ReplaySession[] = [];
  const perProject: Loaded["perProject"] = {};
  const seen = new Set<string>();
  for (const dir of opts.projects) {
    const path = join(opts.root, dir);
    if (!existsSync(path)) {
      console.error(`no such project directory: ${path}`);
      process.exit(2);
    }
    const files = readdirSync(path).filter(isMainTranscriptName);
    const stats = { files: files.length, replayable: 0, replayed: 0, skippedLarge: 0 };
    const parsed: ReplaySession[] = [];
    for (const name of files) {
      const file = join(path, name);
      if (statSync(file).size > MAX_TRANSCRIPT_BYTES) {
        stats.skippedLarge++;
        continue;
      }
      const session = parseTranscript(readFileSync(file, "utf8"), file);
      if (session && session.userTurns.length >= opts.minTurns && !seen.has(session.id)) {
        seen.add(session.id);
        parsed.push(session);
      }
    }
    stats.replayable = parsed.length;
    const chosen = orderByStart(parsed).slice(0, opts.cap);
    stats.replayed = chosen.length;
    perProject[dir] = stats;
    picked.push(...chosen);
  }
  return { sessions: orderByStart(picked), perProject };
}

async function call<T>(baseUrl: string, path: string, init?: RequestInit): Promise<{ body: T; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/agentmemory/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${text.slice(0, 200)}`);
  return { body: JSON.parse(text) as T, ms };
}

const post = <T>(baseUrl: string, path: string, body: unknown) =>
  call<T>(baseUrl, path, { method: "POST", body: JSON.stringify(body) });
const get = <T>(baseUrl: string, path: string) => call<T>(baseUrl, path);

interface ObsRow {
  id: string;
  title?: string;
  subtitle?: string;
  narrative?: string;
  facts?: string[];
  files?: string[];
}

interface InjectionRecordRow {
  source: string;
  at: string;
  injected: Array<{ kind: string; id: string; files?: string[] }>;
}

interface Resolver {
  observations: Map<string, { session: ReplaySession; row: ObsRow }>;
  sessions: Map<string, ReplaySession>;
}

function obsText(row: ObsRow): string {
  return [row.title, row.narrative, ...(row.facts ?? [])].filter(Boolean).join("\n");
}

function itemFor(
  ref: { kind: string; id: string; files?: string[] },
  resolver: Resolver,
  extra: Map<string, { project?: string; text: string }>,
): ProbeItem {
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
async function lessonsAndMemories(baseUrl: string): Promise<Map<string, { project?: string; text: string }>> {
  const out = new Map<string, { project?: string; text: string }>();
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
  const injectionKinds: Array<{ kind: ProbeKind; turn: number; probe: Probe }> = [];
  const failed = (kind: ProbeKind, turn: number): Probe => ({ kind, turn, latencyMs: 0, chars: 0, items: [], failed: true });

  try {
    const { body, ms } = await post<{ context?: string }>(baseUrl, "session/start", {
      sessionId: session.id,
      project: session.project,
      cwd: session.cwd,
    });
    const probe: Probe = { kind: "session-start", turn: 0, latencyMs: ms, chars: body.context?.length ?? 0, items: [] };
    probes.push(probe);
    injectionKinds.push({ kind: "session-start", turn: 0, probe });
  } catch (err) {
    console.warn(`  session-start probe failed: ${errorMessage(err)}`);
    probes.push(failed("session-start", 0));
  }

  for (const turn of session.userTurns.slice(0, maxPrompts)) {
    try {
      const { body, ms } = await post<{ context?: string }>(baseUrl, "prompt-context", {
        sessionId: session.id,
        prompt: turn.text,
        project: session.project,
      });
      const probe: Probe = { kind: "prompt-context", turn: turn.turn, latencyMs: ms, chars: body.context?.length ?? 0, items: [] };
      probes.push(probe);
      injectionKinds.push({ kind: "prompt-context", turn: turn.turn, probe });
    } catch (err) {
      console.warn(`  prompt-context probe failed at turn ${turn.turn}: ${errorMessage(err)}`);
      probes.push(failed("prompt-context", turn.turn));
    }
    try {
      const { body, ms } = await post<{ results?: SearchRow[] }>(baseUrl, "smart-search", {
        query: turn.text,
        limit: SEARCH_LIMIT,
        project: session.project,
      });
      const extra = new Map<string, { project?: string; text: string }>();
      const items = (body.results ?? []).map((r) => {
        const id = r.obsId ?? r.id ?? "";
        return itemFor({ kind: "observation", id }, resolver, extra);
      });
      probes.push({ kind: "search", turn: turn.turn, latencyMs: ms, chars: items.reduce((n, i) => n + i.text.length, 0), items });
    } catch (err) {
      console.warn(`  search probe failed at turn ${turn.turn}: ${errorMessage(err)}`);
      probes.push(failed("search", turn.turn));
    }
  }

  // The daemon records each Injection as it answers; read the records back
  // in order to learn exactly which Memories each probe delivered.
  await new Promise((r) => setTimeout(r, 100));
  const { body } = await get<{ injections?: InjectionRecordRow[] }>(baseUrl, `injections?sessionId=${encodeURIComponent(session.id)}`);
  const records = [...(body.injections ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  const extra = await lessonsAndMemories(baseUrl);
  const delivered = injectionKinds.filter(({ probe }) => !probe.failed);
  if (records.length !== delivered.length) {
    console.warn(`  injection records (${records.length}) do not match probes (${delivered.length})`);
  }
  delivered.forEach(({ probe }, i) => {
    probe.items = (records[i]?.injected ?? []).map((ref) => itemFor(ref, resolver, extra));
  });
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
  const { sessions, perProject } = loadSessions(opts);
  console.log(`replaying ${sessions.length} Sessions from ${opts.projects.length} projects, instance ${opts.instance}`);
  mkdirSync(opts.out, { recursive: true });
  const ndjson = join(opts.out, "scores.ndjson");
  writeFileSync(ndjson, "");

  const sandbox = await startSandbox({ instance: opts.instance, embeddings: opts.embeddings });
  const resolver: Resolver = { observations: new Map(), sessions: new Map() };
  const ingested: ReplaySession[] = [];
  const scores: SessionScore[] = [];
  const bytesStart = storeBytes(sandbox.sqlitePath);
  const t0 = Date.now();
  try {
    for (const [i, session] of sessions.entries()) {
      const key = deriveAnswerKey(session, ingested);
      const probeStart = Date.now();
      const probes = await probeSession(sandbox.baseUrl, session, opts.maxPrompts, resolver);
      const score = scoreSession(session, key, probes);
      scores.push(score);
      appendFileSync(ndjson, `${JSON.stringify(score)}\n`);

      const importStart = Date.now();
      try {
        await post(sandbox.baseUrl, "replay/import-jsonl", { path: session.sourcePath });
        const { body } = await get<{ observations?: ObsRow[] }>(sandbox.baseUrl, `observations?sessionId=${encodeURIComponent(session.id)}`);
        for (const row of body.observations ?? []) resolver.observations.set(row.id, { session, row });
        resolver.sessions.set(session.id, session);
        ingested.push(session);
      } catch (err) {
        console.warn(`  import failed: ${errorMessage(err)}`);
      }
      const injected = score.items.length;
      console.log(
        `[${i + 1}/${sessions.length}] ${session.id.slice(0, 8)} turns=${score.turns} key=${score.outcomes.length} ` +
          `injected=${injected} used=${score.items.filter((x) => x.used).length} ` +
          `hit=${score.outcomes.filter((o) => o.injected).length} probe=${Math.round((importStart - probeStart) / 1000)}s ` +
          `import=${Math.round((Date.now() - importStart) / 1000)}s total=${Math.round((Date.now() - t0) / 1000)}s`,
      );
    }
    const meta = { storeBytesStart: bytesStart, storeBytesEnd: storeBytes(sandbox.sqlitePath) };
    const summary = summarize(scores, meta);
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
