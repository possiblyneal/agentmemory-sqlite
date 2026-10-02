import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { logger } from "../logger.js";

const RECENT_CAP = 20;

export interface AccessLog {
  memoryId: string;
  count: number;
  lastAt: string;
  recent: number[];
}

export function emptyAccessLog(memoryId: string): AccessLog {
  return { memoryId, count: 0, lastAt: "", recent: [] };
}

export function normalizeAccessLog(raw: unknown): AccessLog {
  const r = (raw ?? {}) as Partial<AccessLog>;
  const rawCount =
    typeof r.count === "number" && Number.isFinite(r.count) ? r.count : 0;
  const count = Math.max(0, Math.floor(rawCount));
  const rawRecent = Array.isArray(r.recent)
    ? r.recent.filter(
        (x): x is number => typeof x === "number" && Number.isFinite(x),
      )
    : [];
  const recent =
    rawRecent.length > RECENT_CAP ? rawRecent.slice(-RECENT_CAP) : rawRecent;
  return {
    memoryId: typeof r.memoryId === "string" ? r.memoryId : "",
    count: Math.max(count, recent.length),
    lastAt: typeof r.lastAt === "string" ? r.lastAt : "",
    recent,
  };
}

export async function getAccessLog(
  kv: StateKV,
  memoryId: string,
): Promise<AccessLog> {
  try {
    const raw = await kv.get<AccessLog>(KV.accessLog, memoryId);
    if (!raw) return emptyAccessLog(memoryId);
    const normalized = normalizeAccessLog(raw);
    if (!normalized.memoryId) normalized.memoryId = memoryId;
    return normalized;
  } catch {
    return emptyAccessLog(memoryId);
  }
}

function withAccess(log: AccessLog, ts: number): AccessLog {
  log.count += 1;
  log.lastAt = new Date(ts).toISOString();
  log.recent.push(ts);
  if (log.recent.length > RECENT_CAP) {
    log.recent = log.recent.slice(-RECENT_CAP);
  }
  return log;
}

function warnAccessFailed(memoryId: string, err: unknown): void {
  try {
    logger.warn("recordAccess failed", {
      memoryId,
      error: err instanceof Error ? err.message : String(err),
    });
  } catch {}
}

export async function recordAccess(
  kv: StateKV,
  memoryId: string,
  timestampMs?: number,
): Promise<void> {
  if (!memoryId) return;
  const ts = timestampMs ?? Date.now();
  try {
    await withKeyedLock(`mem:access:${memoryId}`, async () => {
      const existing = await getAccessLog(kv, memoryId);
      await kv.set(KV.accessLog, memoryId, withAccess(existing, ts));
    });
  } catch (err) {
    warnAccessFailed(memoryId, err);
  }
}

// Locks are taken in sorted order so two overlapping batches cannot deadlock.
function withKeyedLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  return [...keys]
    .sort()
    .reduceRight<() => Promise<T>>((inner, key) => () => withKeyedLock(key, inner), fn)();
}

// One `setMany` - one transaction, one fsync - for the whole batch. A write
// per id put one fsync per injected item on every pre-tool-use Injection.
// If the batch write fails, each id is retried alone so one bad row cannot
// cost its siblings their access.
export async function recordAccessBatch(
  kv: StateKV,
  memoryIds: string[],
  timestampMs?: number,
): Promise<void> {
  if (!memoryIds || memoryIds.length === 0) return;
  const ts = timestampMs ?? Date.now();
  const unique = Array.from(new Set(memoryIds.filter(Boolean)));
  if (unique.length === 0) return;
  try {
    await withKeyedLocks(
      unique.map((id) => `mem:access:${id}`),
      async () => {
        const logs = await Promise.all(unique.map((id) => getAccessLog(kv, id)));
        await kv.setMany(
          KV.accessLog,
          logs.map((log, i) => ({ key: unique[i]!, value: withAccess(log, ts) })),
        );
      },
    );
  } catch {
    await Promise.allSettled(unique.map((id) => recordAccess(kv, id, ts)));
  }
}

export async function deleteAccessLog(
  kv: StateKV,
  memoryId: string,
): Promise<void> {
  if (!memoryId) return;
  try {
    await withKeyedLock(`mem:access:${memoryId}`, async () => {
      await kv.delete(KV.accessLog, memoryId);
    });
  } catch {}
}

