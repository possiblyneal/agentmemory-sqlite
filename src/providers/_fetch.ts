import { getEnvVar } from "../config.js";

// Bounded retry for transient rate-limit / unavailable responses. Attempts is
// total tries (initial + retries). Retries are bounded by a TOTAL elapsed
// deadline — not per-attempt — so the worst case never blows past the caller's
// timeout budget. A Retry-After is honored in full when it fits that budget:
// every LLM call is background work, and retrying a busy server sooner than it
// asked only earns another 429.
const MAX_ATTEMPTS = 3;
// A retry only makes sense if there's room for at least a token attempt after
// the sleep; without this floor we'd sleep, fire, and get instantly cut off.
const MIN_ATTEMPT_FLOOR_MS = 100;
const RETRY_STATUS = new Set([429, 503]);

// A non-2xx provider response, carrying its status so callers can tell a busy
// provider from a broken one. SDK errors (Anthropic) carry `status` the same way.
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// OpenAI answers an exhausted quota with 429 too; that never clears by waiting,
// so it counts as broken and opens the breaker.
export function isProviderBusy(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== "number" || !RETRY_STATUS.has(status)) return false;
  return !/insufficient_quota/.test(err instanceof Error ? err.message : "");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a Retry-After header into a delay in milliseconds. Supports both the
 * integer-seconds form and the HTTP-date form. Returns undefined when absent
 * or unparseable, so the caller falls back to exponential backoff. Negative
 * or past values clamp to 0.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

async function fetchOnce(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const ctl = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([init.signal, ctl.signal])
    : ctl.signal;
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...init, signal }).finally(() => clearTimeout(t));
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  const parsed =
    timeoutMs ??
    Number.parseInt(getEnvVar("AGENTMEMORY_LLM_TIMEOUT_MS") ?? "60000", 10);
  const ms = Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;

  // The caller's timeout is the TOTAL budget for all attempts + sleeps, honored
  // exactly: nothing above this Engine imposes a shorter ceiling (ADR 0001).
  const start = Date.now();

  let response: Response = await fetchOnce(url, init, ms);
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    if (!RETRY_STATUS.has(response.status)) return response;

    const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
    // Exponential backoff fallback when no Retry-After: 500ms, 1000ms, ...
    const backoff = 500 * 2 ** (attempt - 1);
    const delay = retryAfter ?? backoff;

    // Stop retrying if the sleep plus a minimal attempt would overrun the total
    // budget — a Retry-After that alone exceeds the remaining budget returns
    // the last response instead of stalling the caller.
    const elapsed = Date.now() - start;
    const remaining = ms - elapsed;
    if (delay + MIN_ATTEMPT_FLOOR_MS > remaining) return response;

    // This response is being discarded for a retry; release its body so the
    // underlying connection is returned to the pool instead of leaking.
    await response.body?.cancel().catch(() => {});
    await sleep(delay);

    // Cap the per-attempt timeout to whatever budget is left so a late attempt
    // can't push total elapsed past the deadline.
    const attemptMs = Math.max(
      MIN_ATTEMPT_FLOOR_MS,
      ms - (Date.now() - start),
    );
    response = await fetchOnce(url, init, attemptMs);
  }
  return response;
}
