import { startSandbox, type EmbeddingMode, type Sandbox } from "../sandbox.js";
import type {
  Adapter,
  EvalObservation,
  Question,
  QueryResult,
  RankedDoc,
  Session,
} from "../types.js";
import { questionPath } from "../types.js";

interface Needle {
  text: string;
  sessionId: string;
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

const PROBE_SESSION_ID = "eval-probe";
const NEEDLE_CHARS = 48;
const SEARCH_TOOLS = new Set(["grep", "glob"]);

function authHeaders(secret?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) h.Authorization = `Bearer ${secret}`;
  return h;
}

async function post<T>(state: Pick<AgentMemoryState, "baseUrl" | "secret">, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${state.baseUrl}/agentmemory/${path}`, {
    method: "POST",
    headers: authHeaders(state.secret),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
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

function observePayload(s: Session, o: EvalObservation, index: number) {
  const project = s.project ?? "eval";
  const base = Date.parse(s.timestamp ?? "2026-01-01T00:00:00Z");
  const common = {
    sessionId: s.id,
    project,
    cwd: `/eval/${project}`,
    timestamp: new Date(base + index * 1000).toISOString(),
  };
  if (o.tool === "prompt") {
    return { ...common, hookType: "prompt_submit", data: { prompt: o.output } };
  }
  const tool = o.tool.toLowerCase();
  const toolInput = SEARCH_TOOLS.has(tool)
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
  const project = s.project ?? "eval";
  await post(state, "session/start", { sessionId: s.id, project, cwd: `/eval/${project}` });
  const observations = s.observations ?? [];
  for (let i = 0; i < observations.length; i++) {
    await post(state, "observe", observePayload(s, observations[i], i));
    state.needles.push({ text: needleFor(observations[i].output), sessionId: s.id });
  }
  await post(state, "session/end", { sessionId: s.id });
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
    const sessionId = row.sessionId ?? (memoryId ? state.memoryToSession.get(memoryId) : undefined);
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    ranked.push({ sessionId, score: row.score ?? 0 });
    if (ranked.length >= k) break;
  }
  return { ranked };
}

async function queryPreToolUse(q: Question, state: AgentMemoryState): Promise<QueryResult> {
  const tool = q.tool ?? "Edit";
  const { context = "" } = await post<{ context?: string }>(state, "enrich", {
    sessionId: PROBE_SESSION_ID,
    files: q.file ? [q.file] : [],
    terms: SEARCH_TOOLS.has(tool.toLowerCase()) && q.pattern ? [q.pattern] : [],
    toolName: tool,
    ...(q.project && { project: q.project }),
  });
  return { ranked: attribute(context, state.needles), chars: context.length };
}

async function querySessionStart(q: Question, state: AgentMemoryState): Promise<QueryResult> {
  const project = q.project ?? "eval";
  const { context = "" } = await post<{ context?: string }>(state, "session/start", {
    sessionId: PROBE_SESSION_ID,
    project,
    cwd: `/eval/${project}`,
  });
  return { ranked: attribute(context, state.needles), chars: context.length };
}

export const agentmemoryAdapter: Adapter<AgentMemoryState> = {
  name: "agentmemory",
  paths: ["search", "pre-tool-use", "session-start"],
  async init(sessions, config) {
    const explicitUrl = (config?.baseUrl as string | undefined) ?? process.env.AGENTMEMORY_BASE_URL;
    const sandbox = explicitUrl
      ? undefined
      : await startSandbox({
          instance: (config?.instance as number | undefined) ?? 3,
          embeddings: (config?.embeddings as EmbeddingMode | undefined) ?? "local",
        });
    const state: AgentMemoryState = {
      baseUrl: explicitUrl ?? sandbox!.baseUrl,
      secret: (config?.secret as string | undefined) ?? process.env.AGENTMEMORY_SECRET,
      sandbox,
      needles: [],
      memoryToSession: new Map(),
    };
    try {
      const ordered = [...sessions].sort((a, b) =>
        (a.timestamp ?? "").localeCompare(b.timestamp ?? ""),
      );
      for (const s of ordered) {
        if (s.observations?.length) await ingestCaptured(state, s);
        else await ingestRemembered(state, s);
      }
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
      case "pre-tool-use":
        return queryPreToolUse(q, state);
      case "session-start":
        return querySessionStart(q, state);
    }
  },
  async teardown(state) {
    await state.sandbox?.stop();
  },
};
