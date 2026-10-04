import type { MemoryProvider } from "../types.js";

const STRICTER_SUFFIX = `

IMPORTANT: Your previous response was invalid. Please ensure your output strictly follows the required XML format. Every required field must be present with valid values.`;

export async function compressWithRetry(
  provider: MemoryProvider,
  systemPrompt: string,
  userPrompt: string,
  validator: (response: string) => { valid: boolean; errors?: string[] },
  maxRetries = 1,
  // Hardened variant of userPrompt for retries (e.g. payload re-encoded as a
  // JSON string literal). A first attempt that failed validation usually
  // failed because the payload derailed the model, so retrying the identical
  // prompt with a sterner system suffix rarely changes the outcome.
  retryUserPrompt?: string,
): Promise<
  | { response: string; retried: boolean }
  | { response: null; retried: true; errors: string[] }
> {
  const first = await provider.compress(systemPrompt, userPrompt);
  let result = validator(first);
  if (result.valid) return { response: first, retried: false };

  for (let i = 0; i < maxRetries; i++) {
    const retry = await provider.compress(
      systemPrompt + STRICTER_SUFFIX,
      retryUserPrompt ?? userPrompt,
    );
    result = validator(retry);
    if (result.valid) return { response: retry, retried: true };
  }

  return { response: null, retried: true, errors: result.errors ?? [] };
}
