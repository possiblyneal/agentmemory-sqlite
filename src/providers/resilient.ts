import type { MemoryProvider, CircuitBreakerState } from "../types.js";
import { CircuitBreaker } from "./circuit-breaker.js";

export type ProviderOperation = "compress" | "summarize" | "describeImage";

const OPERATIONS: ProviderOperation[] = ["compress", "summarize", "describeImage"];

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

  private async call(
    operation: ProviderOperation,
    fn: () => Promise<string>,
  ): Promise<string> {
    const breaker = this.breakers[operation];
    if (!breaker.isAllowed) {
      throw new Error("circuit_breaker_open");
    }
    try {
      const result = await fn();
      breaker.recordSuccess();
      return result;
    } catch (err) {
      breaker.recordFailure();
      throw err;
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
