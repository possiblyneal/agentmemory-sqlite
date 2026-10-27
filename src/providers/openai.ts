import { compressMaxTokens, type CompressOptions, type MemoryProvider, type ProviderUsage } from "../types.js";
import { getEnvVar } from "../config.js";
import { fetchWithTimeout, ProviderHttpError, ProviderTimeoutError } from "./_fetch.js";
import { UsageTally, hostOf } from "./_usage.js";
import {
  DEFAULT_AZURE_API_VERSION,
  buildAuthHeaders,
  buildChatUrl,
  detectAzure,
  normalizeBaseUrl,
} from "./_openai-shared.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const TOKENIZE_TIMEOUT_MS = 10_000;

/**
 * OpenAI-compatible LLM provider.
 *
 * Uses raw fetch (no SDK) to support any OpenAI-compatible endpoint:
 *   - OpenAI official
 *   - Azure OpenAI (auto-detected from .openai.azure.com host)
 *   - DeepSeek
 *   - 硅基流动 (SiliconFlow)
 *   - vLLM / LM Studio / Ollama (with OpenAI compatibility layer)
 *   - Any other proxy implementing /v1/chat/completions
 *
 * Required env vars:
 *   OPENAI_API_KEY  — API key
 *
 * Optional:
 *   OPENAI_BASE_URL          — base URL without path (default: https://api.openai.com).
 *                              Azure: https://<resource>.openai.azure.com/openai/deployments/<deployment>
 *   OPENAI_MODEL             — model name (default: DEFAULT_MODELS in src/config.ts)
 *   OPENAI_API_VERSION       — Azure api-version query param (default: 2024-08-01-preview)
 *   OPENAI_TIMEOUT_MS        — outbound fetch timeout in ms (OpenAI-scoped alias,
 *                              takes precedence over AGENTMEMORY_LLM_TIMEOUT_MS
 *                              for back-compat with the v0.9.17 shipping name).
 *   AGENTMEMORY_LLM_TIMEOUT_MS — outbound fetch timeout in ms shared across all
 *                              raw-fetch LLM providers. Used when
 *                              OPENAI_TIMEOUT_MS is not set. Default: 60000.
 *   MAX_TOKENS               — max output tokens (default: from config or 4096)
 *   OPENAI_REASONING_EFFORT  — "low" | "medium" | "high" | "none"
 *                              Passthrough for reasoning models (e.g. Ollama Cloud
 *                              thinking models). Set to "none" to ensure
 *                              message.content is populated instead of only
 *                              message.reasoning.
 *   OPENAI_EXTRA_BODY        — JSON object merged into every request body, e.g.
 *                              '{"chat_template_kwargs":{"enable_thinking":false}}'.
 *                              Invalid JSON fails at construction.
 */
export class OpenAIProvider implements MemoryProvider {
  name = "openai";
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private baseUrl: string;
  private reasoningEffort?: string;
  private timeoutMs: number;
  private isAzure: boolean;
  private azureApiVersion: string;
  private tokenizeUnavailable = false;
  private extraBody: Record<string, unknown>;
  private tally: UsageTally;
  // api.openai.com rejects max_tokens on reasoning models and accepts
  // max_completion_tokens on every model; compatible servers may only know
  // max_tokens (#1219).
  private outputTokenParam: "max_tokens" | "max_completion_tokens";

  constructor(apiKey: string, model: string, maxTokens: number, baseURL?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.baseUrl = normalizeBaseUrl(baseURL || getEnvVar("OPENAI_BASE_URL"));
    this.reasoningEffort = getEnvVar("OPENAI_REASONING_EFFORT") || undefined;
    this.timeoutMs = resolveTimeout();
    this.extraBody = parseExtraBody(getEnvVar("OPENAI_EXTRA_BODY"));
    this.azureApiVersion =
      getEnvVar("OPENAI_API_VERSION") || DEFAULT_AZURE_API_VERSION;
    this.isAzure = detectAzure(this.baseUrl);
    this.outputTokenParam = /^https:\/\/api\.openai\.com(\/|$)/.test(this.baseUrl)
      ? "max_completion_tokens"
      : "max_tokens";
    this.tally = new UsageTally("openai", model, hostOf(this.baseUrl));
  }

  usage(): ProviderUsage[] {
    return [this.tally.snapshot()];
  }

  async compress(
    systemPrompt: string,
    userPrompt: string,
    options?: CompressOptions,
  ): Promise<string> {
    return this.call(
      systemPrompt,
      userPrompt,
      compressMaxTokens(this.maxTokens, options),
    );
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  // llama.cpp-style servers expose POST /tokenize at the server root, beside
  // /v1. Anything without it answers 404 once and is never asked again for
  // the life of this provider; the caller falls back to an estimate, so a
  // count never blocks the work it measures.
  async countTokens(text: string): Promise<number> {
    const url = `${this.baseUrl.replace(/\/v1$/, "")}/tokenize`;
    if (this.tokenizeUnavailable) {
      throw new Error(`tokenize unavailable at ${url}`);
    }
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: buildAuthHeaders(this.apiKey, this.isAzure),
        body: JSON.stringify({ model: this.model, content: text }),
      },
      TOKENIZE_TIMEOUT_MS,
    );
    if (response.status === 404) {
      this.tokenizeUnavailable = true;
    }
    if (!response.ok) {
      throw new Error(`tokenize error (${response.status}) at ${url}`);
    }
    const data = (await response.json()) as { tokens?: unknown[] };
    if (!Array.isArray(data.tokens)) {
      throw new Error(`tokenize returned no token array from ${url}`);
    }
    return data.tokens.length;
  }

  private async call(
    systemPrompt: string,
    userPrompt: string,
    maxTokens = this.maxTokens,
  ): Promise<string> {
    const url = buildChatUrl(this.baseUrl, this.isAzure, this.azureApiVersion);
    const body: Record<string, unknown> = {
      ...this.extraBody,
      model: this.model,
      [this.outputTokenParam]: maxTokens,
      // Streamed so the timeout bounds silence, not length: a long reply that
      // keeps writing finishes, a stalled one is cut off (#329). A server that
      // ignores it and answers JSON is read as JSON.
      stream: true,
      // Usage arrives in a stream only on request. Azure api-versions before
      // 2024-09-01-preview reject the field, so Azure goes untallied.
      ...(this.isAzure ? {} : { stream_options: { include_usage: true } }),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    if (this.reasoningEffort) {
      body.reasoning_effort = this.reasoningEffort;
    }

    // Bound the request via the shared fetchWithTimeout helper, which
    // owns the AbortController + clearTimeout cleanup for every raw-fetch
    // provider (minimax, openrouter, gemini, openrouter-embed, etc.).
    // OPENAI_TIMEOUT_MS keeps its v0.9.17 meaning (OpenAI-scoped alias,
    // takes precedence); when unset we fall through to
    // AGENTMEMORY_LLM_TIMEOUT_MS and finally the 60s default. See rohitg00/agentmemory#446.
    const hint =
      "set OPENAI_TIMEOUT_MS (or AGENTMEMORY_LLM_TIMEOUT_MS) to raise the bound or check the provider status.";
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: buildAuthHeaders(this.apiKey, this.isAzure),
          body: JSON.stringify(body),
        },
        this.timeoutMs,
        { idle: true },
      );
    } catch (err) {
      if (err instanceof ProviderTimeoutError) {
        throw new ProviderTimeoutError(
          `OpenAI API request got no response within ${this.timeoutMs}ms — ${hint}`,
        );
      }
      throw err;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new ProviderHttpError(`OpenAI API error (${response.status}): ${text}`, response.status);
    }

    const progress = { chars: 0 };
    let data: ChatCompletion;
    try {
      data = await readReply(response, progress);
    } catch (err) {
      if (err instanceof ProviderTimeoutError) {
        throw new ProviderTimeoutError(
          `OpenAI API reply received nothing for ${this.timeoutMs}ms after ${progress.chars} reply chars — ${hint}`,
        );
      }
      throw err;
    }
    this.tally.add(data.usage?.prompt_tokens, data.usage?.completion_tokens);
    const message = data.choices?.[0]?.message;
    const content = message?.content;
    if (content) {
      return content;
    }
    if (data.choices?.[0]?.finish_reason === "length") {
      throw new Error(
        `OpenAI finish_reason length: reply was cut off at max_tokens (${maxTokens}) with no content — turn thinking off with OPENAI_EXTRA_BODY / OPENAI_REASONING_EFFORT, or raise MAX_TOKENS if it set that limit`,
      );
    }
    // Fallback: some thinking models return reasoning but no content.
    // DeepSeek V4 / Qwen3 / GLM / Kimi return `reasoning_content`;
    // older OpenAI o-series + some compatibles return `reasoning`. #627
    const reasoning = message?.reasoning ?? message?.reasoning_content;
    if (reasoning) {
      return reasoning;
    }
    if (data.choices?.[0]?.finish_reason === "content_filter") {
      throw new Error("OpenAI finish_reason content_filter: completion blocked by the provider's content filter");
    }
    throw new Error(
      `OpenAI returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
}

type ChatCompletion = {
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string; reasoning?: string; reasoning_content?: string };
  }>;
};

type ChatChunk = {
  usage?: ChatCompletion["usage"];
  choices?: Array<{
    finish_reason?: string | null;
    delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null };
  }>;
};

// Reads a streamed chat completion back into the shape of a non-streamed one,
// counting reply chars in `progress` so a timeout can say how far it got. The
// body, not its content-type, decides the form: a server that ignores `stream`
// answers JSON, and some proxies label SSE as JSON or plain text.
async function readReply(
  response: Response,
  progress: { chars: number },
): Promise<ChatCompletion> {
  let content = "";
  let reasoning = "";
  let finishReason: string | undefined;
  let usage: ChatCompletion["usage"];
  let done = false;
  const take = (line: string) => {
    if (/^(event:\s*)?error\b/.test(line)) {
      throw new Error(`OpenAI API stream error: ${line}`);
    }
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "") return;
    if (payload === "[DONE]") {
      done = true;
      return;
    }
    const chunk = JSON.parse(payload) as ChatChunk & { error?: unknown };
    if (chunk.error !== undefined) {
      throw new Error(`OpenAI API stream error: ${JSON.stringify(chunk.error)}`);
    }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    content += delta?.content ?? "";
    reasoning += delta?.reasoning_content ?? delta?.reasoning ?? "";
    progress.chars = content.length + reasoning.length;
  };

  const decoder = new TextDecoder();
  let buffered = "";
  let json: boolean | undefined;
  for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(bytes, { stream: true });
    json ??= buffered.trimStart() === "" ? undefined : buffered.trimStart().startsWith("{");
    if (json !== false) continue;
    const lines = buffered.split("\n");
    buffered = lines.pop()!;
    lines.forEach(take);
  }
  buffered += decoder.decode();
  if (json) return JSON.parse(buffered) as ChatCompletion;
  take(buffered);

  if (!done && !finishReason) {
    throw new Error(
      `OpenAI API stream ended without finishing after ${progress.chars} reply chars`,
    );
  }
  return {
    usage,
    choices: [{ finish_reason: finishReason, message: { content, reasoning_content: reasoning } }],
  };
}

// Resolves the outbound-fetch timeout for the OpenAI LLM path.
// Precedence (preserving v0.9.17 behaviour):
//   1. OPENAI_TIMEOUT_MS       — OpenAI-scoped alias (back-compat)
//   2. AGENTMEMORY_LLM_TIMEOUT_MS — global LLM timeout (rohitg00/agentmemory#446)
//   3. 60 000 ms default
function resolveTimeout(): number {
  const openaiRaw = getEnvVar("OPENAI_TIMEOUT_MS");
  const openai = parsePositiveInt(openaiRaw);
  if (openai !== undefined) return openai;

  const globalRaw = getEnvVar("AGENTMEMORY_LLM_TIMEOUT_MS");
  const globalMs = parsePositiveInt(globalRaw);
  if (globalMs !== undefined) return globalMs;

  return DEFAULT_TIMEOUT_MS;
}

function parseExtraBody(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`OPENAI_EXTRA_BODY is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OPENAI_EXTRA_BODY must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parsePositiveInt(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  // Reject malformed values like "30ms" or "1_000" — parseInt would
  // silently return 30 / 1, swallowing user typos as valid timeouts.
  // The regex enforces pure digits (no sign, no trailing units, no
  // separators) before we hand off to Number.
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

