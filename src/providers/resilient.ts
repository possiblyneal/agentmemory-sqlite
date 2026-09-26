import type { MemoryProvider, CircuitBreakerState } from "../types.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { isContentFilterRejection, isProviderBusy } from "./_fetch.js";
import { getEnvVar } from "../config.js";

export type ProviderOperation = "compress" | "summarize" | "describeImage";

const OPERATIONS: ProviderOperation[] = ["compress", "summarize", "describeImage"];

const MAX_CONCURRENCY_DEFAULT = 4;

function maxConcurrency(): number {
  const raw = getEnvVar("AGENTMEMORY_LLM_MAX_CONCURRENCY")?.trim();
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
  return n > 0 ? n : MAX_CONCURRENCY_DEFAULT;
}

const SEVERITY: Record<CircuitBreakerState["state"], number> = {
  closed: 0,
  "half-open": 1,
  open: 2,
};

// One breaker per operation: a provider that cannot summarize a long
// Session must not stop it compressing the next Observation.
export class ResilientProvider implements MemoryProvider {
  private breakers = Object.fromEntries(
    OPERATIONS.map((op) => [op, new CircuitBreaker()]),
  ) as Record<ProviderOperation, CircuitBreaker>;
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  name: string;
  // A failed count is a fallback for the caller, not a provider failure,
  // so it is forwarded outside the breaker.
  countTokens?: (text: string) => Promise<number>;
  describeImage?: (imageData: string, mimeType: string, prompt: string) => Promise<string>;

  constructor(private inner: MemoryProvider) {
    this.name = `resilient(${inner.name})`;
    if (inner.countTokens) {
      this.countTokens = (text) => inner.countTokens!(text);
    }
    if (inner.describeImage) {
      this.describeImage = (imageData, mimeType, prompt) =>
        this.call("describeImage", () =>
          inner.describeImage!(imageData, mimeType, prompt),
        );
    }
  }

  // One cap across every generating operation: a busy provider is busy for all
  // of them, and fanning out past it only turns queued work into 429s.
  // countTokens stays outside it; summarize bounds those with COUNT_CONCURRENCY.
  private async acquireSlot(): Promise<void> {
    if (this.inFlight < maxConcurrency()) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.inFlight--;
  }

  private async call(
    operation: ProviderOperation,
    fn: () => Promise<string>,
  ): Promise<string> {
    const breaker = this.breakers[operation];
    if (!breaker.isAllowed) {
      throw new Error("circuit_breaker_open");
    }
    await this.acquireSlot();
    try {
      const result = await fn();
      breaker.recordSuccess();
      return result;
    } catch (err) {
      // A provider that says "busy" or filtered one prompt is healthy; opening
      // the breaker on it would fail unrelated work for the whole cooldown.
      if (!isProviderBusy(err) && !isContentFilterRejection(err)) breaker.recordFailure();
      throw err;
    } finally {
      this.releaseSlot();
    }
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call("compress", () => this.inner.compress(systemPrompt, userPrompt));
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call("summarize", () => this.inner.summarize(systemPrompt, userPrompt));
  }

  get circuitStates(): Record<ProviderOperation, CircuitBreakerState> {
    return Object.fromEntries(
      OPERATIONS.map((op) => [op, this.breakers[op].getState()]),
    ) as Record<ProviderOperation, CircuitBreakerState>;
  }

  // Most severe operation wins, so a health consumer reading one state
  // still sees an open breaker.
  get circuitState(): CircuitBreakerState {
    return Object.values(this.circuitStates).reduce((worst, s) =>
      SEVERITY[s.state] > SEVERITY[worst.state] ? s : worst,
    );
  }
}
