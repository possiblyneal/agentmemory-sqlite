import type { ProviderUsage } from "../types.js";

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

export class UsageTally {
  private promptTokens = 0;
  private completionTokens = 0;

  constructor(
    private provider: string,
    private model: string,
    private endpointHost: string,
  ) {}

  add(prompt: unknown, completion: unknown): void {
    if (typeof prompt === "number" && Number.isFinite(prompt)) this.promptTokens += prompt;
    if (typeof completion === "number" && Number.isFinite(completion)) {
      this.completionTokens += completion;
    }
  }

  snapshot(): ProviderUsage {
    return {
      provider: this.provider,
      model: this.model,
      endpointHost: this.endpointHost,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
    };
  }
}
