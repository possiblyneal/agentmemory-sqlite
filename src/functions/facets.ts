import type { ISdk } from "../engine/types.js";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import type { Facet } from "../types.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { logger } from "../logger.js";
import { scrubFields } from "./privacy.js";

const FACET_LOCK = "mem:facet:mutate";

export function withFacetLock<T>(fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(FACET_LOCK, fn);
}

type FacetIndex = { generation: number; targets: Map<string, Set<string>> };
const facetIndexes = new WeakMap<StateKV, FacetIndex>();

async function facetIndex(kv: StateKV): Promise<FacetIndex> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = await kv.writeGeneration(KV.facets);
    const cached = facetIndexes.get(kv);
    if (cached?.generation === generation) return cached;
    const targets = new Map<string, Set<string>>();
    let after: string | undefined;
    for (;;) {
      const page = await kv.listPage<Facet>(KV.facets, after, 256);
      for (const row of page) {
        let keys = targets.get(row.value.targetId);
        if (!keys) targets.set(row.value.targetId, keys = new Set());
        keys.add(row.key);
      }
      if (page.length < 256) break;
      after = page[page.length - 1].key;
    }
    if (generation === await kv.writeGeneration(KV.facets)) {
      const index = { generation, targets };
      facetIndexes.set(kv, index);
      return index;
    }
  }
  throw new Error("Facet scope changed during index rebuild");
}

async function cleanupFacets(kv: StateKV, deleted: string[]): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const index = await facetIndex(kv);
    let stale = false;
    for (const target of new Set(deleted)) {
      const keys = index.targets.get(target);
      if (!keys) continue;
      for (const key of keys) {
        const facet = await kv.get<Facet>(KV.facets, key);
        if (await kv.writeGeneration(KV.facets) !== index.generation) {
          stale = true;
          break;
        }
        if (facet?.targetId !== target) {
          keys.delete(key);
          continue;
        }
        try {
          await kv.delete(KV.facets, key);
          keys.delete(key);
          const generation = await kv.writeGeneration(KV.facets);
          if (generation !== index.generation + 1) {
            stale = true;
            break;
          }
          index.generation = generation;
        } catch (error) {
          facetIndexes.delete(kv);
          logger.warn("Facet cleanup failed", { facetId: key, error: String(error) });
        }
      }
      if (stale) break;
      if (keys.size === 0) index.targets.delete(target);
    }
    if (!stale) return;
    facetIndexes.delete(kv);
  }
  throw new Error("Facet scope changed during cleanup");
}

export async function deleteWithFacets<T>(kv: StateKV, remove: (deleted: string[]) => Promise<T>): Promise<T> {
  return withFacetLock(async () => {
    const deleted: string[] = [];
    try {
      return await remove(deleted);
    } finally {
      if (deleted.length) {
        try {
          await cleanupFacets(kv, deleted);
        } catch (error) {
          facetIndexes.delete(kv);
          logger.warn("Facet cleanup failed", { error: String(error) });
        }
      }
    }
  });
}

export function registerFacetsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::facet-tag", 
    async (data: {
      targetId: string;
      targetType: string;
      dimension: string;
      value: string;
    }) => {
      data = scrubFields(data, "value");
      if (!data.targetId || typeof data.targetId !== "string") {
        return { success: false, error: "targetId is required" };
      }

      const validTypes = ["memory", "observation"];
      if (!validTypes.includes(data.targetType)) {
        return {
          success: false,
          error: `targetType must be one of: ${validTypes.join(", ")}`,
        };
      }

      if (
        !data.dimension ||
        typeof data.dimension !== "string" ||
        data.dimension.trim() === ""
      ) {
        return { success: false, error: "dimension is required" };
      }

      if (
        !data.value ||
        typeof data.value !== "string" ||
        data.value.trim() === ""
      ) {
        return { success: false, error: "value is required" };
      }

      const dimension = data.dimension.trim();
      const value = data.value.trim();

      return withFacetLock(async () => {
        const existing = await kv.list<Facet>(KV.facets);
        const duplicate = existing.find(
          (f) =>
            f.targetId === data.targetId &&
            f.dimension === dimension &&
            f.value === value,
        );
        if (duplicate) {
          return { success: true, facet: duplicate, skipped: true };
        }

        const facet: Facet = {
          id: generateId("fct"),
          targetId: data.targetId,
          targetType: data.targetType as Facet["targetType"],
          dimension,
          value,
          createdAt: new Date().toISOString(),
        };

        await kv.set(KV.facets, facet.id, facet);
        return { success: true, facet };
      });
    },
  );

  sdk.registerFunction("mem::facet-untag", 
    async (data: {
      targetId: string;
      dimension: string;
      value?: string;
    }) => {
      if (!data.targetId) {
        return { success: false, error: "targetId is required" };
      }
      if (!data.dimension) {
        return { success: false, error: "dimension is required" };
      }

      return withFacetLock(async () => {
        const all = await kv.list<Facet>(KV.facets);
        const matches = all.filter((f) => {
          if (f.targetId !== data.targetId || f.dimension !== data.dimension) {
            return false;
          }
          if (data.value !== undefined) {
            return f.value === data.value;
          }
          return true;
        });

        for (const f of matches) {
          await kv.delete(KV.facets, f.id);
        }

        return { success: true, removed: matches.length };
      });
    },
  );

  sdk.registerFunction("mem::facet-query", 
    async (data: {
      matchAll?: string[];
      matchAny?: string[];
      targetType?: string;
      limit?: number;
    }) => {
      if (
        (!data.matchAll || data.matchAll.length === 0) &&
        (!data.matchAny || data.matchAny.length === 0)
      ) {
        return {
          success: false,
          error: "at least one of matchAll or matchAny is required",
        };
      }

      const all = await kv.list<Facet>(KV.facets);
      const filtered = data.targetType
        ? all.filter((f) => f.targetType === data.targetType)
        : all;

      const targetFacetMap = new Map<string, { targetType: string; facetKeys: Set<string> }>();
      for (const f of filtered) {
        const key = `${f.dimension}:${f.value}`;
        let entry = targetFacetMap.get(f.targetId);
        if (!entry) {
          entry = { targetType: f.targetType, facetKeys: new Set() };
          targetFacetMap.set(f.targetId, entry);
        }
        entry.facetKeys.add(key);
      }

      const results: Array<{ targetId: string; targetType: string; matchedFacets: string[] }> = [];

      for (const [targetId, entry] of targetFacetMap) {
        const matched: string[] = [];

        if (data.matchAll && data.matchAll.length > 0) {
          const allPresent = data.matchAll.every((k) => entry.facetKeys.has(k));
          if (!allPresent) continue;
          for (const k of data.matchAll) {
            if (!matched.includes(k)) matched.push(k);
          }
        }

        if (data.matchAny && data.matchAny.length > 0) {
          const anyPresent = data.matchAny.filter((k) => entry.facetKeys.has(k));
          if (anyPresent.length === 0) continue;
          for (const k of anyPresent) {
            if (!matched.includes(k)) matched.push(k);
          }
        }

        results.push({
          targetId,
          targetType: entry.targetType,
          matchedFacets: matched,
        });
      }

      const limit = data.limit || 50;
      return { success: true, results: results.slice(0, limit) };
    },
  );

  sdk.registerFunction("mem::facet-get", 
    async (data: { targetId: string }) => {
      if (!data.targetId) {
        return { success: false, error: "targetId is required" };
      }

      const all = await kv.list<Facet>(KV.facets);
      const targetFacets = all.filter((f) => f.targetId === data.targetId);

      const dimMap = new Map<string, string[]>();
      for (const f of targetFacets) {
        let values = dimMap.get(f.dimension);
        if (!values) {
          values = [];
          dimMap.set(f.dimension, values);
        }
        values.push(f.value);
      }

      const dimensions = Array.from(dimMap.entries()).map(([dimension, values]) => ({
        dimension,
        values,
      }));

      return { success: true, dimensions };
    },
  );

  sdk.registerFunction("mem::facet-stats", 
    async (data: { targetType?: string }) => {
      const all = await kv.list<Facet>(KV.facets);
      const filtered = data.targetType
        ? all.filter((f) => f.targetType === data.targetType)
        : all;

      const dimMap = new Map<string, Map<string, number>>();
      for (const f of filtered) {
        let valueMap = dimMap.get(f.dimension);
        if (!valueMap) {
          valueMap = new Map();
          dimMap.set(f.dimension, valueMap);
        }
        valueMap.set(f.value, (valueMap.get(f.value) || 0) + 1);
      }

      const dimensions = Array.from(dimMap.entries()).map(([dimension, valueMap]) => ({
        dimension,
        values: Array.from(valueMap.entries()).map(([value, count]) => ({
          value,
          count,
        })),
      }));

      return { success: true, dimensions, totalFacets: filtered.length };
    },
  );

  sdk.registerFunction("mem::facet-dimensions", 
    async () => {
      const all = await kv.list<Facet>(KV.facets);

      const counts = new Map<string, number>();
      for (const f of all) {
        counts.set(f.dimension, (counts.get(f.dimension) || 0) + 1);
      }

      const dimensions = Array.from(counts.entries()).map(([dimension, count]) => ({
        dimension,
        count,
      }));

      return { success: true, dimensions };
    },
  );
}
