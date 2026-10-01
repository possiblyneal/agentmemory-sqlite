import type { ISdk } from "../engine/types.js";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import type { InjectionRecord } from "../types.js";
import { logger } from "../logger.js";

export const INJECTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function recordInjection(
  kv: StateKV,
  record: Omit<InjectionRecord, "id" | "at">,
): Promise<void> {
  const id = generateId("inj");
  await kv.set<InjectionRecord>(KV.injections, id, {
    id,
    ...record,
    at: new Date().toISOString(),
  });
}

export function registerInjectionsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::injections-list",
    async (data: { sessionId: string }) => {
      const records = await kv.list<InjectionRecord>(KV.injections);
      const injections = records
        .filter((r) => r.sessionId === data.sessionId)
        .sort((a, b) => a.at.localeCompare(b.at));
      return { success: true, injections };
    },
  );

  sdk.registerFunction("mem::injections-sweep", async () => {
    const cutoff = Date.now() - INJECTION_RETENTION_MS;
    const records = await kv.list<InjectionRecord>(KV.injections);
    const expired = records.filter((r) => new Date(r.at).getTime() < cutoff);
    await Promise.all(expired.map((r) => kv.delete(KV.injections, r.id)));
    if (expired.length > 0) {
      logger.info("Injection records swept", { swept: expired.length });
    }
    return { success: true, swept: expired.length };
  });
}
