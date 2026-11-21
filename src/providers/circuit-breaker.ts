import type { CircuitBreakerState } from "../types.js";

interface CircuitBreakerOptions {
  failureThreshold?: number;
  failureWindowMs?: number;
  recoveryTimeoutMs?: number;
}

function positiveFinite(val: number | undefined, fallback: number): number {
  return Number.isFinite(val) && val! > 0 ? val! : fallback;
}

export class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private failures = 0;
  private lastFailureAt: number | null = null;
  private openedAt: number | null = null;
  private probeInFlight = false;
  private generation = 0;

  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly recoveryTimeoutMs: number;

  constructor(opts?: CircuitBreakerOptions) {
    this.failureThreshold = Math.max(
      1,
      Math.floor(positiveFinite(opts?.failureThreshold, 3)),
    );
    this.failureWindowMs = positiveFinite(opts?.failureWindowMs, 60_000);
    this.recoveryTimeoutMs = positiveFinite(opts?.recoveryTimeoutMs, 30_000);
  }

  get isAllowed(): boolean {
    if (this.state === "closed") return true;
    const now = Date.now();
    if (this.state === "open") {
      if (this.openedAt === null || now - this.openedAt < this.recoveryTimeoutMs) {
        return false;
      }
      this.state = "half-open";
      this.probeInFlight = false;
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    this.generation++;
    return true;
  }

  acquire(): number | null {
    return this.isAllowed ? this.generation : null;
  }

  releaseProbe(generation = this.generation): void {
    if (generation === this.generation && this.state === "half-open") this.probeInFlight = false;
  }

  recordSuccess(generation = this.generation): void {
    if (generation !== this.generation) return;
    if (this.state === "half-open") {
      this.state = "closed";
      this.generation++;
      this.failures = 0;
      this.lastFailureAt = null;
      this.openedAt = null;
      this.probeInFlight = false;
    }
  }

  recordFailure(generation = this.generation): void {
    if (generation !== this.generation || this.state === "open") return;
    const now = Date.now();
    if (this.state === "half-open") {
      this.state = "open";
      this.generation++;
      this.openedAt = now;
      this.probeInFlight = false;
      return;
    }
    if (this.lastFailureAt && now - this.lastFailureAt > this.failureWindowMs) {
      this.failures = 0;
    }
    this.failures += 1;
    this.lastFailureAt = now;
    if (this.failures >= this.failureThreshold) {
      this.state = "open";
      this.generation++;
      this.openedAt = now;
    }
  }

  getState(): CircuitBreakerState {
    const recoveryDue =
      this.state === "open" &&
      this.openedAt !== null &&
      Date.now() - this.openedAt >= this.recoveryTimeoutMs;
    return {
      state: recoveryDue ? "half-open" : this.state,
      failures: this.failures,
      lastFailureAt: this.lastFailureAt,
      openedAt: this.openedAt,
    };
  }
}
