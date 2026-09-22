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
// the chunked summarize fan-out (SUMMARIZE_CHUNK_CONCURRENCY, default 2)
// and refusing those chunks would trip the skip-ratio bailout and lose
// the whole summary.
const MAX_CONCURRENT_DEFAULT = 2
// Nothing else bounds an SDK call in time. `fetchWithTimeout`'s cap covers
// the raw-fetch providers only; here the work happens inside a spawned
// `claude` process, so a child that wedges leaves its caller awaiting for
// as long as the process lives — and, since the cap above, holding its
// concurrency slot for just as long. 180 s rather than the 60 s the fetch
// providers default to: this budget has to cover a CLI cold start on top
// of the model call. Resolved the way OpenAI's is — provider knob first,
// then the shared one — and used for the queue wait too, so a caller that
// has waited longer than a call is allowed to take stops waiting.
// The slot goes back on the timeout, not on the child exiting: a wedged
// child cannot be waited for without reintroducing the hang. So the cap
// bounds children the daemon is still waiting on, and a host that wedges
// repeatedly can hold more than the cap — the operator's `kill -KILL`
// remains the recovery for those, as #27 says.
const SDK_BUDGET_DEFAULT_MS = 180000

let sdkInFlight = 0
const sdkWaiters: Array<() => void> = []

function positiveIntEnv(key: string, fallback: number): number {
  const raw = getEnvVar(key)
  if (!raw) return fallback
  // Pure digits only, the way `parsePositiveInt` reads the same
  // AGENTMEMORY_LLM_TIMEOUT_MS for the OpenAI path: parseInt would read
  // "30s" as 30 ms here while that provider rejected it, so one variable
  // would mean two different things.
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return fallback
  const n = Number(trimmed)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function sdkBudgetMs(): number {
  return positiveIntEnv(
    'AGENTMEMORY_AGENT_SDK_TIMEOUT_MS',
    positiveIntEnv('AGENTMEMORY_LLM_TIMEOUT_MS', SDK_BUDGET_DEFAULT_MS),
  )
}

// Distinguishable from any string the drain can produce.
const TIMED_OUT = Symbol('agent-sdk-timeout')

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
    }, sdkBudgetMs())
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

      const budgetMs = sdkBudgetMs()
      let expiry: ReturnType<typeof setTimeout> | undefined
      try {
        const { query } = await this.loadSdk()

        // Aborting is what lets the SDK close the child down (stdin EOF,
        // then a grace window) instead of leaving it orphaned.
        const abortController = new AbortController()
        const messages = query({
          prompt: userPrompt,
          options: {
            systemPrompt,
            maxTurns: 1,
            allowedTools: [],
            abortController,
          },
        })

        const drain = (async () => {
          let result = ''
          for await (const msg of messages) {
            if (msg.type === 'result') {
              result = (msg as any).result ?? ''
            }
          }
          return result
        })()

        // Raced rather than merely aborted: a child that ignores the
        // shutdown is exactly the case this bounds, and waiting on the
        // abort to take effect would be waiting on the same wedge again.
        const outcome = await Promise.race([
          drain,
          new Promise<typeof TIMED_OUT>((resolve) => {
            expiry = setTimeout(() => resolve(TIMED_OUT), budgetMs)
            expiry.unref?.()
          }),
        ])

        if (outcome !== TIMED_OUT) return outcome

        logger.warn('Agent-SDK call timed out', {
          budgetMs,
          knob: 'AGENTMEMORY_AGENT_SDK_TIMEOUT_MS',
        })
        abortController.abort()
        // Ask the iterator to close, and swallow whatever the abandoned
        // drain settles as — nobody is reading it now. On the wedge this
        // bounds, `return()` queues behind the `next()` the drain is
        // already parked in and does not run until a message arrives, so
        // it releases a cooperative child promptly and a wedged one only
        // when the process finally dies. That is why the slot is freed on
        // the timeout rather than on the child exiting.
        void Promise.resolve(messages.return?.(undefined as never)).catch(
          () => {},
        )
        void drain.catch(() => {})
        // The same empty result the recursion guard returns: callers
        // short-circuit to synthetic compression rather than hanging.
        return ''
      } finally {
        if (expiry) clearTimeout(expiry)
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
