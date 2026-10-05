import type { ISdk } from '../engine/types.js'

export const SET_MANY_CHUNK = 100

const GRAPH_SCOPE_PREFIX = 'mem:graph:'
let graphWriteCount = 0

// Bumps on every write to a graph scope through any StateKV, so a cached view
// of the graph can tell it is stale. The daemon is the only writer.
export function graphWriteGeneration(): number {
  return graphWriteCount
}

export function noteGraphWrite(scope: string): void {
  if (scope.startsWith(GRAPH_SCOPE_PREFIX)) graphWriteCount++
}

// Counted when the write settles, so a view built while it was in flight is
// stamped with an older generation and rebuilt.
async function trackWrite<T>(scope: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } finally {
    noteGraphWrite(scope)
  }
}

export class StateKV {
  constructor(private sdk: ISdk) {}

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    return this.sdk.trigger<{ scope: string; key: string }, T | null>({
      function_id: 'state::get',
      payload: { scope, key },
    })
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    return trackWrite(scope, () =>
      this.sdk.trigger<{ scope: string; key: string; value: T }, T>({
        function_id: 'state::set',
        payload: { scope, key, value },
      }),
    )
  }

  async update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T> {
    return trackWrite(scope, () =>
      this.sdk.trigger<
        { scope: string; key: string; ops: Array<{ type: string; path: string; value?: unknown }> },
        T
      >({
        function_id: 'state::update',
        payload: { scope, key, ops },
      }),
    )
  }

  async delete(scope: string, key: string): Promise<void> {
    return trackWrite(scope, () =>
      this.sdk.trigger<{ scope: string; key: string }, void>({
        function_id: 'state::delete',
        payload: { scope, key },
      }),
    )
  }

  // Bounded batches. Each chunk is one `state::set-many` call - one
  // transaction, one fsync - and the await between chunks lets the event loop
  // turn; a `state::set` per row was 45k fsyncs back to back (day-0 soak
  // finding).
  async setMany<T = unknown>(scope: string, entries: Array<{ key: string; value: T }>): Promise<number> {
    return trackWrite(scope, async () => {
      for (let i = 0; i < entries.length; i += SET_MANY_CHUNK) {
        await this.sdk.trigger<{ scope: string; entries: Array<{ key: string; value: T }> }, number>({
          function_id: 'state::set-many',
          payload: { scope, entries: entries.slice(i, i + SET_MANY_CHUNK) },
        })
      }
      return entries.length
    })
  }

  // Bounded batches like setMany. Deletes only rows whose updatedAt is still
  // the one the caller read, and returns the keys it deleted.
  async deleteManyIfUnchanged(
    scope: string,
    entries: Array<{ key: string; updatedAt: string }>,
  ): Promise<string[]> {
    return trackWrite(scope, async () => {
      const deleted: string[] = []
      for (let i = 0; i < entries.length; i += SET_MANY_CHUNK) {
        deleted.push(
          ...(await this.sdk.trigger<
            { scope: string; entries: Array<{ key: string; updatedAt: string }> },
            string[]
          >({
            function_id: 'state::delete-many-if-unchanged',
            payload: { scope, entries: entries.slice(i, i + SET_MANY_CHUNK) },
          })),
        )
      }
      return deleted
    })
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    return this.sdk.trigger<{ scope: string }, T[]>({
      function_id: 'state::list',
      payload: { scope },
    })
  }

  async bytes(scope: string): Promise<number> {
    return this.sdk.trigger<{ scope: string }, number>({
      function_id: 'state::bytes',
      payload: { scope },
    })
  }

  async listScopes(prefix: string): Promise<string[]> {
    return this.sdk.trigger<{ prefix: string }, string[]>({
      function_id: 'state::list-scopes',
      payload: { prefix },
    })
  }
}
