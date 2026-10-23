import Anthropic from '@anthropic-ai/sdk'
import { compressMaxTokens, type CompressOptions, type MemoryProvider, type ProviderUsage } from '../types.js'
import { getEnvVar } from '../config.js'
import { UsageTally, hostOf } from './_usage.js'
import { fetchWithTimeout } from './_fetch.js'

const DEFAULT_TIMEOUT_MS = 60_000

function resolveTimeoutMs(): number {
  const parsed = Number.parseInt(getEnvVar('AGENTMEMORY_LLM_TIMEOUT_MS') ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

type Effort = NonNullable<Anthropic.OutputConfig['effort']>

export class AnthropicProvider implements MemoryProvider {
  name = 'anthropic'
  private client: Anthropic
  private model: string
  private maxTokens: number
  private effort?: Effort
  private tally: UsageTally

  constructor(apiKey: string, model: string, maxTokens: number, baseURL?: string) {
    const timeoutMs = resolveTimeoutMs()
    // fetchWithTimeout owns the single deadline and the retries; the SDK's own
    // timeout only has to outlast it and its retries are off (#313).
    this.client = new Anthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      maxRetries: 0,
      timeout: timeoutMs + 5_000,
      fetch: (url, init) => fetchWithTimeout(String(url), init ?? {}, timeoutMs),
    })
    this.model = model
    this.maxTokens = maxTokens
    this.tally = new UsageTally('anthropic', model, hostOf(baseURL || 'https://api.anthropic.com'))
    // ANTHROPIC_EFFORT -> output_config.effort, mirroring OPENAI_REASONING_EFFORT
    // in openai.ts. Unset leaves the model at its own default, which on Claude
    // Opus 5 means adaptive thinking is on: measured at 18s on a hard
    // consolidation against the hard 30s compress timeout in consolidate.ts,
    // versus 11s at "medium". Levels are model-specific - Haiku 4.5 rejects the
    // parameter outright and only Opus 5 accepts "xhigh".
    this.effort = (getEnvVar('ANTHROPIC_EFFORT') || undefined) as Effort | undefined
  }

  usage(): ProviderUsage[] {
    return [this.tally.snapshot()]
  }

  private get outputConfig() {
    return this.effort ? { output_config: { effort: this.effort } } : {}
  }

  async compress(systemPrompt: string, userPrompt: string, options?: CompressOptions): Promise<string> {
    return this.call(systemPrompt, userPrompt, compressMaxTokens(this.maxTokens, options))
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt)
  }

  async describeImage(imageData: string, mimeType: string, prompt: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      ...this.outputConfig,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: imageData },
          },
          { type: 'text', text: prompt },
        ],
      }],
    })

    this.tally.add(response.usage?.input_tokens, response.usage?.output_tokens)
    const textBlock = response.content.find((b) => b.type === 'text')
    return textBlock?.text ?? ''
  }

  private async call(systemPrompt: string, userPrompt: string, maxTokens = this.maxTokens): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      ...this.outputConfig,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })

    this.tally.add(response.usage?.input_tokens, response.usage?.output_tokens)
    const textBlock = response.content.find((b) => b.type === 'text')
    return textBlock?.text ?? ''
  }
}
