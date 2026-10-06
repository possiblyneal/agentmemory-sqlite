import { daemonCall } from "../daemon-http.js";
import { startSandbox, type EmbeddingMode, type Sandbox } from "../sandbox.js";
import { randomUUID } from "node:crypto";
import type {
  Adapter,
  AdapterConfig,
  EvalObservation,
  Question,
  QueryResult,
  RankedDoc,
  Session,
} from "../types.js";
import { questionPath } from "../types.js";
import { VERSION } from "../../../src/version.js";

interface Needle {
  text: string;
  sessionId: string;
}

export interface AgentMemoryConfig extends AdapterConfig {
  embeddings?: EmbeddingMode;
  secret?: string;
}

interface AgentMemoryState {
  baseUrl: string;
  secret?: string;
  sandbox?: Sandbox;
  needles: Needle[];
  memoryToSession: Map<string, string>;
}

interface SmartSearchResponse {
  results?: Array<{ obsId?: string; id?: string; sessionId?: string; score?: number }>;
}

const NEEDLE_CHARS = 48;
const SEARCH_TOOLS = new Set(["grep", "glob"]);

function isSearchTool(tool: string): boolean {
  return SEARCH_TOOLS.has(tool.toLowerCase());
}

function projectScope(project: string | undefined): { project: string; cwd: string } {
  const name = project ?? "eval";
  return { project: name, cwd: `/eval/${name}` };
}

// Each probe is a Session of its own, so what one question's probe leaves
// behind cannot change the Injection a later question sees.
function probeSessionId(): string {
  return `eval-probe-${randomUUID()}`;
}

async function post<T>(state: Pick<AgentMemoryState, "baseUrl" | "secret">, path: string, body: unknown): Promise<T> {
  return (await daemonCall<T>(state.baseUrl, path, { body, secret: state.secret })).body;
}

function normalize(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

export function needleFor(output: string): string {
  return normalize(output).slice(0, NEEDLE_CHARS);
}

// An Injection is text, so it is mapped back to eval Sessions by finding
// each Observation's output in it. Order is first appearance, which is the
// order the Agent reads it in.
export function attribute(context: string, needles: Needle[]): RankedDoc[] {
  const haystack = normalize(context);
  const firstSeen = new Map<string, number>();
  for (const n of needles) {
    const at = haystack.indexOf(n.text);
    if (at === -1) continue;
    const prev = firstSeen.get(n.sessionId);
    if (prev === undefined || at < prev) firstSeen.set(n.sessionId, at);
  }
  return [...firstSeen]
    .sort((a, b) => a[1] - b[1])
    .map(([sessionId, at]) => ({ sessionId, score: -at }));
}

function observeTimestamp(s: Session, index: number): string {
  const base = Date.parse(s.timestamp ?? "2026-01-01T00:00:00Z");
  return new Date(base + index * 1000).toISOString();
}

function observePayload(s: Session, o: EvalObservation, index: number) {
  const common = {
    sessionId: s.id,
    ...projectScope(s.project),
    timestamp: observeTimestamp(s, index),
  };
  if (o.tool === "prompt") {
    return { ...common, hookType: "prompt_submit", data: { prompt: o.output } };
  }
  const toolInput = isSearchTool(o.tool)
    ? { pattern: o.pattern ?? "", path: o.file ?? "." }
    : o.file
      ? { file_path: o.file }
      : { command: `step ${index}` };
  return {
    ...common,
    hookType: "post_tool_use",
    data: { tool_name: o.tool, tool_input: toolInput, tool_output: o.output },
  };
}

async function ingestCaptured(state: AgentMemoryState, s: Session): Promise<void> {
  await post(state, "session/start", { sessionId: s.id, ...projectScope(s.project) });
  const observations = s.observations ?? [];
  for (let i = 0; i < observations.length; i++) {
    await post(state, "observe", observePayload(s, observations[i], i));
    if (!observations[i].routine) {
      state.needles.push({ text: needleFor(observations[i].output), sessionId: s.id });
    }
  }
  await post(state, "session/end", { sessionId: s.id });
  await applyImportance(state, s);
}

interface StoredObservation {
  timestamp: string;
  importance?: number;
}

async function storedObservations(state: AgentMemoryState, sessionId: string): Promise<StoredObservation[]> {
  const { body } = await daemonCall<{ observations?: StoredObservation[] }>(
    state.baseUrl,
    `observations?sessionId=${encodeURIComponent(sessionId)}`,
    { secret: state.secret },
  );
  return body.observations ?? [];
}

// What the sandbox holds, not what the dataset says: the daemon has to have
// kept more than one importance, or the ranking is as unexercised as before.
async function assertStoredImportanceVaried(state: AgentMemoryState, sessions: Session[]): Promise<void> {
  const rated = sessions.filter((s) => s.observations?.some((o) => o.importance !== undefined));
  if (rated.length === 0) return;
  const stored = await Promise.all(rated.map((s) => storedObservations(state, s.id)));
  const values = new Set(stored.flat().map((o) => o.importance));
  if (values.size < 2) throw new Error("the sandbox stored a single Observation importance");
}

// Synthetic compression rates every Observation 5 and the sandbox has no LLM
// to rate them, so the dataset's fixed ratings are written back through the
// import endpoint, which merges over the stored rows by id.
async function applyImportance(state: AgentMemoryState, s: Session): Promise<void> {
  const rated = new Map<string, number>();
  (s.observations ?? []).forEach((o, i) => {
    if (o.importance !== undefined) rated.set(observeTimestamp(s, i), o.importance);
  });
  if (rated.size === 0) return;
  const stored = await storedObservations(state, s.id);
  const updated = stored
    .filter((o) => rated.has(o.timestamp))
    .map((o) => ({ ...o, importance: rated.get(o.timestamp) }));
  if (updated.length !== rated.size) {
    throw new Error(`${s.id}: stored ${updated.length} of ${rated.size} rated Observations`);
  }
  const result = await post<{ success?: boolean; error?: string }>(state, "import", {
    exportData: {
      version: VERSION,
      sessions: [],
      memories: [],
      summaries: [],
      observations: { [s.id]: updated },
    },
    strategy: "merge",
  });
  if (!result.success) throw new Error(`importance import failed: ${result.error}`);
}

// A rated dataset must rate on more than one value, or session-start ranking
// by importance would be exercised no more than under synthetic compression.
export function assertVariedImportance(sessions: Session[]): void {
  const ratings = sessions.flatMap((s) => (s.observations ?? []).map((o) => o.importance));
  if (ratings.some((r) => r !== undefined) && new Set(ratings).size < 2) {
    throw new Error("rated Observations all carry one importance; the ranking would go unexercised");
  }
}

async function ingestRemembered(state: AgentMemoryState, s: Session): Promise<void> {
  const body = await post<{ memory?: { id?: string }; id?: string }>(state, "remember", {
    content: s.content,
    type: "eval-session",
    concepts: [s.id],
  });
  const memoryId = body.memory?.id ?? body.id;
  if (memoryId) state.memoryToSession.set(memoryId, s.id);
}

async function querySearch(q: Question, state: AgentMemoryState, k: number): Promise<QueryResult> {
  const body = await post<SmartSearchResponse>(state, "smart-search", {
    query: q.question,
    limit: Math.max(k * 10, 50),
    ...(q.project && { project: q.project }),
  });
  const ranked: RankedDoc[] = [];
  const seen = new Set<string>();
  for (const row of body.results ?? []) {
    const memoryId = row.obsId ?? row.id;
    // A remembered eval Session comes back under the "memory" placeholder
    // Session, so its own mapping must win.
    const sessionId = (memoryId && state.memoryToSession.get(memoryId)) || row.sessionId;
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    ranked.push({ sessionId, score: row.score ?? 0 });
    if (ranked.length >= k) break;
  }
  return { ranked };
}

async function querySessionStart(q: Question, state: AgentMemoryState): Promise<QueryResult> {
  const { context = "" } = await post<{ context?: string }>(state, "session/start", {
    sessionId: probeSessionId(),
    ...projectScope(q.project),
  });
  return { ranked: attribute(context, state.needles), chars: context.length };
}

async function queryPromptSubmit(q: Question, state: AgentMemoryState): Promise<QueryResult> {
  const { context = "" } = await post<{ context?: string }>(state, "prompt-context", {
    sessionId: probeSessionId(),
    prompt: q.question,
    ...(q.project && { project: q.project }),
  });
  return { ranked: attribute(context, state.needles), chars: context.length };
}

// The daemon to score is the caller's choice: with no `baseUrl` the adapter
// starts its own sandbox, so a runner that must never touch a live store
// (the CI gate) simply passes none.
export const agentmemoryAdapter: Adapter<AgentMemoryState, AgentMemoryConfig> = {
  name: "agentmemory",
  paths: ["search", "session-start", "prompt-submit"],
  async init(sessions, config = {}) {
    const sandbox = config.baseUrl
      ? undefined
      : await startSandbox({
          instance: config.instance ?? 3,
          embeddings: config.embeddings ?? "local",
        });
    const state: AgentMemoryState = {
      baseUrl: config.baseUrl ?? sandbox!.baseUrl,
      secret: config.secret ?? process.env.AGENTMEMORY_SECRET,
      sandbox,
      needles: [],
      memoryToSession: new Map(),
    };
    try {
      assertVariedImportance(sessions);
      const ordered = [...sessions].sort((a, b) =>
        (a.timestamp ?? "").localeCompare(b.timestamp ?? ""),
      );
      for (const s of ordered) {
        if (s.observations?.length) await ingestCaptured(state, s);
        else await ingestRemembered(state, s);
      }
      await assertStoredImportanceVaried(state, sessions);
    } catch (err) {
      await sandbox?.stop();
      throw err;
    }
    return state;
  },
  async query(q, state, k) {
    switch (questionPath(q)) {
      case "search":
        return querySearch(q, state, k);
      case "session-start":
        return querySessionStart(q, state);
      case "prompt-submit":
        return queryPromptSubmit(q, state);
    }
  },
  async teardown(state) {
    await state.sandbox?.stop();
  },
};

export const agentmemoryBm25Adapter: Adapter<AgentMemoryState, AgentMemoryConfig> = {
  ...agentmemoryAdapter,
  name: "agentmemory-bm25",
  init: (sessions, config) => agentmemoryAdapter.init(sessions, { ...config, embeddings: "none" }),
};
