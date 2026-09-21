import { AsyncLocalStorage } from 'node:async_hooks'
import type { MemoryProvider } from '../types.js'
import { getEnvVar } from '../config.js'
import { logger } from '../logger.js'

// #781: the recursion guard used to live on `process.env.AGENTMEMORY_SDK_CHILD`
// (#181). #472 then introduced chunked summarize that runs chunks
// concurrently in the same process via Promise.all. The first chunk
// flipped the global env to "1" synchronously before its `await`, and
// every sibling chunk in the same batch immediately bailed out as a
// "child" — returning "" — so half-plus of the chunks failed to parse
// and the summarize threw `too_many_chunks_skipped: N/N`.
//
// Split the guard so each concern uses the right primitive:
//
//   - **In-process** recursion guard: AsyncLocalStorage. Scoped to the
//     async call tree of the SDK query, so concurrent siblings on the
//     same provider instance no longer see each other's marker.
//   - **Cross-process** recursion guard for hooks: still
//     `process.env.AGENTMEMORY_SDK_CHILD = "1"` around the SDK call.
//     Subprocesses spawned by `@anthropic-ai/claude-agent-sdk` inherit
//     `process.env` at spawn time, so the hook scripts (which run as
//     separate processes) still see the marker and skip their REST
//     callback to /summarize. ALS does not cross process boundaries.
const sdkChildContext = new AsyncLocalStorage<true>()

// Module-level refcount for the process.env marker. A per-call snapshot
// races across overlapping calls: A saves prev=undef, B saves prev="1",
// A's finally restores undef while B is still mid-flight (so any child
// process B spawns won't inherit the marker), and B's finally restores
// "1" — leaking the marker into the global env after the last caller.
// Reference-count instead so only the first entrant snapshots the
// original value and only the last exit restores it.
let sdkActiveCount = 0
let sdkOriginalEnv: string | undefined

// Every SDK query spawns a real `claude` child process of its own, around
// 190 MB resident, and nothing upstream of this provider bounds how many
// callers arrive at once: one broker outage turns every in-flight
// observation into a child, and children that wedge ignore SIGTERM. Cap
// the number that may exist at a time. Callers over the cap wait for a
// slot rather than being refused, because legitimate concurrency here is
// the chunked summarize fan-out (SUMMARIZE_CHUNK_CONCURRENCY, default 6)
// and refusing those chunks would trip the skip-ratio bailout and lose
// the whole summary.
const MAX_CONCURRENT_DEFAULT = 2
// A wedged child holds its slot forever, so the wait has to end somewhere.
// Reuse the LLM budget: a caller that has queued for longer than one call
// is allowed to take is not waiting on load, it is waiting on a wedge.
const QUEUE_WAIT_DEFAULT_MS = 60000

let sdkInFlight = 0
const sdkWaiters: Array<() => void> = []

function positiveIntEnv(key: string, fallback: number): number {
  const raw = getEnvVar(key)
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Resolves true once a slot is held, false when the wait expired. The
// waiter removes itself from the queue on expiry so a released slot is
// never handed to a caller that has already given up.
function acquireSlot(): Promise<boolean> {
  if (sdkInFlight < positiveIntEnv('AGENTMEMORY_AGENT_SDK_MAX_CONCURRENCY', MAX_CONCURRENT_DEFAULT)) {
    sdkInFlight++
    return Promise.resolve(true)
  }
  // Queueing is the cap working, not a fault: the give-up below is the
  // line that means something is wrong.
  logger.info('Agent-SDK concurrency cap reached — queueing', {
    inFlight: sdkInFlight,
    queued: sdkWaiters.length + 1,
  })
  return new Promise<boolean>((resolve) => {
    let settled = false
    const grant = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sdkInFlight++
      resolve(true)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const i = sdkWaiters.indexOf(grant)
      if (i >= 0) sdkWaiters.splice(i, 1)
      resolve(false)
    }, positiveIntEnv('AGENTMEMORY_LLM_TIMEOUT_MS', QUEUE_WAIT_DEFAULT_MS))
    // The process must still be able to exit while a caller waits here.
    timer.unref?.()
    sdkWaiters.push(grant)
  })
}

function releaseSlot(): void {
  sdkInFlight--
  sdkWaiters.shift()?.()
}

type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

export class AgentSDKProvider implements MemoryProvider {
  name = 'agent-sdk'

  // Memoize the dynamic import so concurrent callers share one resolution
  // instead of racing to resolve the specifier independently. Keeps the
  // SDK out of the cold-start path for users on other providers.
  private sdkPromise: Promise<ClaudeAgentSdkModule> | null = null

  private loadSdk(): Promise<ClaudeAgentSdkModule> {
    if (!this.sdkPromise) {
      this.sdkPromise = import('@anthropic-ai/claude-agent-sdk')
    }
    return this.sdkPromise
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.query(systemPrompt, userPrompt)
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.query(systemPrompt, userPrompt)
  }

  private async query(systemPrompt: string, userPrompt: string): Promise<string> {
    // In-process recursion guard. Concurrent sibling calls (chunked
    // summarize via Promise.all) each have their own ALS frame, so they
    // do not poison each other.
    if (sdkChildContext.getStore()) {
      // We are already inside a Claude Agent SDK-spawned async call
      // tree. Spawning another one would let its plugin-hook-driven
      // Stop loop re-enter /agentmemory/summarize and cause unbounded
      // recursion (#149 follow-up). Degrade to empty string so callers
      // short-circuit. The chunk retry path in src/functions/summarize.ts
      // treats "" as a parse failure but only the in-process re-entry
      // path can reach this branch — legitimate concurrent siblings now
      // run with their own ALS frames.
      return ''
    }

    if (!(await acquireSlot())) {
      logger.warn('Agent-SDK call gave up waiting for a concurrency slot', {
        inFlight: sdkInFlight,
        queued: sdkWaiters.length,
      })
      return ''
    }

    try {
      return await this.runQuery(systemPrompt, userPrompt)
    } finally {
      releaseSlot()
    }
  }

  private runQuery(systemPrompt: string, userPrompt: string): Promise<string> {
    return sdkChildContext.run(true, async () => {
      // Mark spawned subprocesses (the SDK's underlying Claude session
      // + its hook scripts) as SDK children via process.env. Hook scripts
      // run in separate processes and read process.env to short-circuit
      // their REST callbacks. Reference-counted so overlapping calls
      // don't race each other into restoring stale values.
      if (sdkActiveCount === 0) {
        sdkOriginalEnv = process.env.AGENTMEMORY_SDK_CHILD
        process.env.AGENTMEMORY_SDK_CHILD = '1'
      }
      sdkActiveCount++

      try {
        const { query } = await this.loadSdk()

        const messages = query({
          prompt: userPrompt,
          options: {
            systemPrompt,
            maxTurns: 1,
            allowedTools: [],
          },
        })

        let result = ''
        for await (const msg of messages) {
          if (msg.type === 'result') {
            result = (msg as any).result ?? ''
          }
        }
        return result
      } finally {
        sdkActiveCount--
        if (sdkActiveCount === 0) {
          if (sdkOriginalEnv === undefined) {
            delete process.env.AGENTMEMORY_SDK_CHILD
          } else {
            process.env.AGENTMEMORY_SDK_CHILD = sdkOriginalEnv
          }
          sdkOriginalEnv = undefined
        }
      }
    })
  }
}
