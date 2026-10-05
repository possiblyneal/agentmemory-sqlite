import { vi } from "vitest";

type Handler = (data: unknown) => Promise<unknown>;

export function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    update: async (
      scope: string,
      key: string,
      ops: Array<{ type?: string; path: string; value?: unknown }>,
    ) => {
      const old_value = store.get(scope)?.get(key);
      const new_value = structuredClone((old_value ?? {}) as Record<string, unknown>);
      for (const op of ops) {
        if (op.type === "remove") delete new_value[op.path];
        else new_value[op.path] = op.value;
      }
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, new_value);
      return { old_value, new_value };
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    listPage: async <T>(
      scope: string,
      after: string | undefined,
      limit: number,
    ): Promise<Array<{ key: string; value: T }>> =>
      [...(store.get(scope)?.entries() ?? [])]
        .filter(([key]) => key > (after ?? ""))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, limit)
        .map(([key, value]) => ({ key, value: value as T })),
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
    listScopes: async (prefix: string): Promise<string[]> =>
      [...store.keys()].filter((scope) => scope.startsWith(prefix)),
  };
}

export function mockSdk(opts?: { looseTrigger?: boolean }) {
  const functions = new Map<string, Handler>();
  const looseTrigger = opts?.looseTrigger ?? false;
  return {
    fns: functions,
    registerFunction: (
      idOrOpts: string | { id: string },
      handler: Handler,
      _options?: Record<string, unknown>,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: vi.fn(),
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : (idOrInput.payload as unknown);
      const fn = functions.get(id);
      if (!fn) {
        // looseTrigger mirrors production fan-out where side-effect
        // triggers (cascade, events) may target functions another
        // module registers; tests exercising one module opt in.
        if (looseTrigger) return null;
        throw new Error(`No function: ${id}`);
      }
      return fn(payload);
    },
  };
}
