import type { CompressOptions, MemoryProvider, ProviderUsage } from "../types.js";

export class FallbackChainProvider implements MemoryProvider {
  name: string;
  // Counts follow the primary: that is the model the text is chunked for.
  countTokens?: (text: string) => Promise<number>;
  describeImage?: (imageData: string, mimeType: string, prompt: string) => Promise<string>;

  constructor(private providers: MemoryProvider[]) {
    this.name = `fallback(${providers.map((p) => p.name).join(" -> ")})`;
    const primary = providers[0];
    if (primary?.countTokens) {
      this.countTokens = (text) => primary.countTokens!(text);
    }
    const seeing = providers.filter((p) => p.describeImage);
    if (seeing.length > 0) {
      this.describeImage = (imageData, mimeType, prompt) =>
        this.tryAll(
          (p) => p.describeImage!(imageData, mimeType, prompt),
          seeing,
        );
    }
  }

  usage(): ProviderUsage[] {
    return this.providers.flatMap((p) => p.usage?.() ?? []);
  }

  async compress(
    systemPrompt: string,
    userPrompt: string,
    options?: CompressOptions,
  ): Promise<string> {
    return this.tryAll((p) => p.compress(systemPrompt, userPrompt, options));
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.tryAll((p) => p.summarize(systemPrompt, userPrompt));
  }

  private async tryAll(
    fn: (p: MemoryProvider) => Promise<string>,
    providers: MemoryProvider[] = this.providers,
  ): Promise<string> {
    let lastError: Error | null = null;
    for (const provider of providers) {
      try {
        return await fn(provider);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError || new Error("No providers available");
  }
}
