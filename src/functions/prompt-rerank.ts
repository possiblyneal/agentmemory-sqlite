import { getPromptRerankConfig } from "../config.js";
import { logger } from "../logger.js";
import { fetchWithTimeout } from "../providers/_fetch.js";

export const RERANK_COOLDOWN_MS = 60_000;
export const RERANK_QUERY_CHARS = 500;
const RERANK_NARRATIVE_CHARS = 400;

// The date lets the reranker answer "what happened on <day>" questions, which
// score near zero against title and narrative alone.
export function rerankDocument(observation: { timestamp?: string; title?: string; narrative?: string }): string {
  const date = observation.timestamp?.slice(0, 10) ?? "";
  return `${date} ${observation.title ?? ""} ${(observation.narrative ?? "").slice(0, RERANK_NARRATIVE_CHARS)}`.trim();
}

type FailureReason = "timeout" | "connection" | "malformed" | `http_${number}`;

export interface InjectionGateState {
  enabled: boolean;
  url: string;
  calls: number;
  fallbacks: number;
  failing: boolean;
  lastFailure: { reason: FailureReason; at: string; sinceBootSeconds: number } | null;
}

let calls = 0;
let fallbacks = 0;
let failing = false;
let lastFailure: InjectionGateState["lastFailure"] = null;
let cooldownUntil = 0;

export function resetInjectionGate(): void {
  calls = 0;
  fallbacks = 0;
  failing = false;
  lastFailure = null;
  cooldownUntil = 0;
}

export function injectionGateState(): InjectionGateState {
  const { enabled, url } = getPromptRerankConfig();
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

function recordFailure(reason: FailureReason, url: string): void {
  const now = Date.now();
  const alreadyCooling = now < cooldownUntil;
  fallbacks++;
  failing = true;
  lastFailure = { reason, at: new Date(now).toISOString(), sinceBootSeconds: Math.round(process.uptime()) };
  cooldownUntil = now + RERANK_COOLDOWN_MS;
  if (alreadyCooling) return;
  logger.warn("Injection Gate failed; injecting BM25 selection", {
    reason,
    url,
    retryInSeconds: RERANK_COOLDOWN_MS / 1000,
  });
}

// null means keep the BM25 selection: the gate is off, cooling down, or failed.
export async function relevantOrder(prompt: string, documents: string[]): Promise<number[] | null> {
  const config = getPromptRerankConfig();
  if (!config.enabled) return null;

  if (Date.now() < cooldownUntil) {
    fallbacks++;
    return null;
  }

  calls++;
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
    failing = false;
    return scores
      .map((score, index) => ({ score, index }))
      .filter(({ score }) => score >= config.minScore)
      .sort((a, b) => b.score - a.score)
      .map(({ index }) => index);
  } catch (err) {
    recordFailure(failureReason(err), config.url);
    return null;
  }
}
