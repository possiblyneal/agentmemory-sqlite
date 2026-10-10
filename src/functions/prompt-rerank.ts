import { getPromptRerankConfig } from "../config.js";
import { logger } from "../logger.js";
import { fetchWithTimeout } from "../providers/_fetch.js";

export const RERANK_COOLDOWN_MS = 60_000;
export const RERANK_QUERY_CHARS = 500;
const RERANK_NARRATIVE_CHARS = 400;

// The date lets the reranker answer "what happened on <day>" questions, which
// score near zero against title and narrative alone.
export function rerankDocument(observation: { timestamp?: unknown; title?: string; narrative?: string }): string {
  const date = typeof observation.timestamp === "string" ? observation.timestamp.slice(0, 10) : "";
  return `${date} ${observation.title ?? ""} ${(observation.narrative ?? "").slice(0, RERANK_NARRATIVE_CHARS)}`.trim();
}

// Each caller keeps its own cooldown and counts, so a slow search never
// switches prompt-submit Injection to its BM25 selection.
export type GateCaller = "prompt-submit" | "search";

type FailureReason = "timeout" | "connection" | "malformed" | `http_${number}`;

export interface InjectionGateState {
  enabled: boolean;
  url: string;
  calls: number;
  fallbacks: number;
  failing: boolean;
  lastFailure: { reason: FailureReason; at: string; sinceBootSeconds: number } | null;
}

interface GateCounters {
  calls: number;
  fallbacks: number;
  failing: boolean;
  lastFailure: InjectionGateState["lastFailure"];
  cooldownUntil: number;
}

const freshCounters = (): GateCounters => ({
  calls: 0,
  fallbacks: 0,
  failing: false,
  lastFailure: null,
  cooldownUntil: 0,
});

const gates: Record<GateCaller, GateCounters> = { "prompt-submit": freshCounters(), search: freshCounters() };

export function resetInjectionGate(): void {
  gates["prompt-submit"] = freshCounters();
  gates.search = freshCounters();
}

export function injectionGateState(caller: GateCaller): InjectionGateState {
  const { enabled, url } = getPromptRerankConfig();
  const { calls, fallbacks, failing, lastFailure } = gates[caller];
  return { enabled, url, calls, fallbacks, failing, lastFailure };
}

class RerankFailure extends Error {
  constructor(readonly reason: FailureReason) {
    super(reason);
  }
}

function isAbort(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  return name === "AbortError" || name === "TimeoutError";
}

function failureReason(err: unknown): FailureReason {
  if (err instanceof RerankFailure) return err.reason;
  return isAbort(err) ? "timeout" : "connection";
}

// Every document must be scored exactly once: a partial or duplicated
// reply would silently drop or repeat an Injection instead of falling back.
function parseScores(body: unknown, documents: number): number[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== documents) throw new RerankFailure("malformed");
  const scores = new Array<number>(documents);
  for (const r of results as ({ index?: unknown; relevance_score?: unknown } | null)[]) {
    const index = r?.index;
    const score = r?.relevance_score;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= documents) {
      throw new RerankFailure("malformed");
    }
    if (typeof score !== "number" || !Number.isFinite(score) || scores[index] !== undefined) {
      throw new RerankFailure("malformed");
    }
    scores[index] = score;
  }
  return scores;
}

function recordFailure(caller: GateCaller, reason: FailureReason, url: string): void {
  const gate = gates[caller];
  const now = Date.now();
  const alreadyCooling = now < gate.cooldownUntil;
  gate.fallbacks++;
  gate.failing = true;
  gate.lastFailure = { reason, at: new Date(now).toISOString(), sinceBootSeconds: Math.round(process.uptime()) };
  gate.cooldownUntil = now + RERANK_COOLDOWN_MS;
  if (alreadyCooling) return;
  logger.warn("Injection Gate failed; keeping BM25 selection", {
    caller,
    reason,
    url,
    retryInSeconds: RERANK_COOLDOWN_MS / 1000,
  });
}

// null means keep the BM25 selection: the gate is off, cooling down, or failed.
export async function relevantOrder(
  caller: GateCaller,
  prompt: string,
  documents: string[],
): Promise<number[] | null> {
  const config = getPromptRerankConfig();
  if (!config.enabled) return null;

  const gate = gates[caller];
  if (Date.now() < gate.cooldownUntil) {
    gate.fallbacks++;
    return null;
  }

  gate.calls++;
  try {
    const response = await fetchWithTimeout(
      config.url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: prompt.slice(0, RERANK_QUERY_CHARS), documents }),
      },
      config.timeoutMs,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new RerankFailure(`http_${response.status}`);
    }
    const body: unknown = await response.json().catch((err: unknown) => {
      throw isAbort(err) ? err : new RerankFailure("malformed");
    });
    const scores = parseScores(body, documents.length);
    gate.failing = false;
    return scores
      .map((score, index) => ({ score, index }))
      .filter(({ score }) => score >= config.minScore)
      .sort((a, b) => b.score - a.score)
      .map(({ index }) => index);
  } catch (err) {
    recordFailure(caller, failureReason(err), config.url);
    return null;
  }
}

export async function gateByRelevance<T>(
  caller: GateCaller,
  query: string,
  items: T[],
  observationOf: (item: T) => Parameters<typeof rerankDocument>[0],
): Promise<T[]> {
  if (items.length === 0) return items;
  const order = await relevantOrder(caller, query, items.map((item) => rerankDocument(observationOf(item))));
  return order ? order.map((index) => items[index]) : items;
}
