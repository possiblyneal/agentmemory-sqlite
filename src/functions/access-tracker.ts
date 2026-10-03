import { KV } from "../state/schema.js";
import { SET_MANY_CHUNK, type StateKV } from "../state/kv.js";
import { withKeyedLock, withKeyedLocks } from "../state/keyed-mutex.js";
import { logger } from "../logger.js";

const RECENT_CAP = 20;

function accessLockKey(memoryId: string): string {
  return `mem:access:${memoryId}`;
}

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

function applyAccess(log: AccessLog, ts: number): AccessLog {
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
    await withKeyedLock(accessLockKey(memoryId), async () => {
      const existing = await getAccessLog(kv, memoryId);
      await kv.set(KV.accessLog, memoryId, applyAccess(existing, ts));
    });
  } catch (err) {
    warnAccessFailed(memoryId, err);
  }
}

// One transaction, one fsync, per SET_MANY_CHUNK ids. A write per id put one
// fsync per injected item on every Injection. If a chunk fails,
// only the ids not yet written are retried alone, so none is counted twice
// and one bad row cannot cost its siblings their access.
export async function recordAccessBatch(
  kv: StateKV,
  memoryIds: string[],
  timestampMs?: number,
): Promise<void> {
  if (!memoryIds || memoryIds.length === 0) return;
  const ts = timestampMs ?? Date.now();
  const unique = Array.from(new Set(memoryIds.filter(Boolean)));
  if (unique.length === 0) return;
  const unwritten = new Set(unique);
  try {
    await withKeyedLocks(unique.map(accessLockKey), async () => {
      const logs = await Promise.all(unique.map((id) => getAccessLog(kv, id)));
      const entries = logs.map((log, i) => ({ key: unique[i]!, value: applyAccess(log, ts) }));
      for (let i = 0; i < entries.length; i += SET_MANY_CHUNK) {
        const chunk = entries.slice(i, i + SET_MANY_CHUNK);
        await kv.setMany(KV.accessLog, chunk);
        for (const { key } of chunk) unwritten.delete(key);
      }
    });
  } catch {
    await Promise.allSettled([...unwritten].map((id) => recordAccess(kv, id, ts)));
  }
}

export async function deleteAccessLog(
  kv: StateKV,
  memoryId: string,
): Promise<void> {
  if (!memoryId) return;
  try {
    await withKeyedLock(accessLockKey(memoryId), async () => {
      await kv.delete(KV.accessLog, memoryId);
    });
  } catch {}
}

