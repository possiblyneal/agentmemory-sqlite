import { getPromptRerankConfig } from "../config.js";
import { logger } from "../logger.js";
import { fetchWithTimeout } from "../providers/_fetch.js";

export const RERANK_COOLDOWN_MS = 60_000;
export const RERANK_QUERY_CHARS = 500;

export interface RerankScore {
  index: number;
  score: number;
}

export interface PromptGateState {
  enabled: boolean;
  url: string;
  calls: number;
  fallbacks: number;
  lastFailure: { reason: string; at: string; sinceBootSeconds: number } | null;
}

let calls = 0;
let fallbacks = 0;
let lastFailure: PromptGateState["lastFailure"] = null;
let cooldownUntil = 0;

export function resetPromptGate(): void {
  calls = 0;
  fallbacks = 0;
  lastFailure = null;
  cooldownUntil = 0;
}

export function promptGateState(): PromptGateState {
  const { enabled, url } = getPromptRerankConfig();
  return { enabled, url, calls, fallbacks, lastFailure };
}

class RerankFailure extends Error {}

function failureReason(err: unknown): string {
  if (err instanceof RerankFailure) return err.message;
  const name = err instanceof Error ? err.name : "";
  return name === "AbortError" || name === "TimeoutError" ? "timeout" : "connection";
}

function parseScores(body: unknown, documents: number): RerankScore[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new RerankFailure("malformed");
  return results.map((r: { index?: unknown; relevance_score?: unknown } | null) => {
    const index = r?.index;
    const score = r?.relevance_score;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= documents) {
      throw new RerankFailure("malformed");
    }
    if (typeof score !== "number" || !Number.isFinite(score)) throw new RerankFailure("malformed");
    return { index, score };
  });
}

function recordFailure(reason: string, url: string, now: number): void {
  fallbacks++;
  lastFailure = { reason, at: new Date(now).toISOString(), sinceBootSeconds: Math.round(process.uptime()) };
  cooldownUntil = now + RERANK_COOLDOWN_MS;
  logger.warn("Prompt rerank gate failed; injecting BM25 selection", {
    reason,
    url,
    retryInSeconds: RERANK_COOLDOWN_MS / 1000,
  });
}

/**
 * Scores documents against the prompt. Returns null whenever the caller
 * should keep the BM25 selection unchanged: gate disabled, cooling down
 * after a failure, or the endpoint failed.
 */
export async function rerankDocuments(prompt: string, documents: string[]): Promise<RerankScore[] | null> {
  const config = getPromptRerankConfig();
  if (!config.enabled) return null;

  const now = Date.now();
  if (now < cooldownUntil) {
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
    const body: unknown = await response.json().catch(() => {
      throw new RerankFailure("malformed");
    });
    return parseScores(body, documents.length);
  } catch (err) {
    recordFailure(failureReason(err), config.url, now);
    return null;
  }
}
