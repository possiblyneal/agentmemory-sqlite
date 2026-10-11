import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerRememberFunction } from "../src/functions/remember.js";
import {
  getSearchIndex,
  setEmbeddingProvider,
  setInprocStores,
  setVectorIndex,
} from "../src/functions/search.js";
import { SqliteState } from "../src/engine/inproc/state.js";
import { SqliteVectorStore } from "../src/engine/inproc/vectors.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { Memory } from "../src/types.js";

function blockedEmbedder() {
  const gates: Array<() => void> = [];
  const provider = {
    name: "stub",
    dimensions: 2,
    embed: async () => new Float32Array([1, 0]),
    embedBatch: async (texts: string[]) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return texts.map(() => new Float32Array([1, 0]));
    },
  };
  return { provider, gates };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("mem::remember embeds outside the save lock", () => {
  let dir: string;
  let state: SqliteState;
  let vectors: VectorIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "am-remember-embed-"));
    state = new SqliteState(join(dir, "state.sqlite"));
    vectors = new VectorIndex();
    const store = new SqliteVectorStore(state);
    vectors.attachStore(store);
    setInprocStores(state, store);
    setVectorIndex(vectors);
  });

  afterEach(() => {
    setEmbeddingProvider(null);
    setInprocStores(null, null);
    setVectorIndex(null);
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const functions = new Map<string, Function>();
    const sdk = {
      registerFunction: (id: string, h: Function) => void functions.set(id, h),
      registerTrigger: () => {},
      trigger: async (input: { function_id: string; payload: unknown }) =>
        functions.get(input.function_id)?.(input.payload),
    };
    const kv = {
      get: async <T>(scope: string, key: string): Promise<T | null> =>
        state.get<T>(scope, key) ?? null,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        state.set(scope, key, data);
        return data;
      },
      delete: async (scope: string, key: string): Promise<void> => {
        state.delete(scope, key);
      },
      list: async <T>(scope: string): Promise<T[]> => state.list<T>(scope),
    };
    registerRememberFunction(sdk as never, kv as never);
    const remember = (data: Record<string, unknown>) =>
      functions.get("mem::remember")!(data) as Promise<any>;
    return { remember };
  }

  it("lets a second save finish while the first save's embedding is still in flight", async () => {
    const { provider, gates } = blockedEmbedder();
    setEmbeddingProvider(provider);
    const { remember } = setup();

    const first = remember({ content: "first decision about caching layers" });
    await tick();
    expect(gates).toHaveLength(1);

    const second = remember({ content: "second note about retry budgets" });
    await tick();
    expect(gates).toHaveLength(2);
    gates[1]();
    expect((await second).success).toBe(true);

    gates[0]();
    expect((await first).success).toBe(true);
  });

  it("indexes the Memory in BM25 before its embedding resolves", async () => {
    const { provider, gates } = blockedEmbedder();
    setEmbeddingProvider(provider);
    const { remember } = setup();

    const saving = remember({ content: "zebrafish pipeline uses sharded queues" });
    await tick();
    expect(gates).toHaveLength(1);
    const hits = getSearchIndex().search("zebrafish", 5);
    expect(hits.some((h) => h.obsId.startsWith("mem_"))).toBe(true);

    gates[0]();
    await saving;
  });

  it("drops the vector of a Memory rewritten while its embedding was in flight", async () => {
    const { provider, gates } = blockedEmbedder();
    setEmbeddingProvider(provider);
    const { remember } = setup();

    const saving = remember({ content: "original wording of the decision" });
    await tick();
    expect(gates).toHaveLength(1);
    const [stored] = state.list<Memory>(KV.memories);
    state.set(KV.memories, stored.id, {
      ...stored,
      content: "rewritten wording of the decision",
    });

    gates[0]();
    await saving;
    expect(vectors.size).toBe(0);
  });

  it("stores the vector when the Memory is unchanged", async () => {
    const { provider, gates } = blockedEmbedder();
    setEmbeddingProvider(provider);
    const { remember } = setup();

    const saving = remember({ content: "unchanged wording of the decision" });
    await tick();
    gates[0]();
    expect((await saving).success).toBe(true);
    expect(vectors.size).toBe(1);
  });
});
