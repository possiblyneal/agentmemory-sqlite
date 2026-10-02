import type { ISdk } from "../engine/types.js";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import type {
  CompressedObservation,
  Crystal,
  InjectedRef,
  InjectionRecord,
  Insight,
  Memory,
} from "../types.js";
import { logger } from "../logger.js";

export const INJECTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function withFiles(ref: InjectedRef, files: string[] | undefined): InjectedRef {
  return files && files.length > 0 ? { ...ref, files } : ref;
}

function sameFile(a: string, b: string): boolean {
  const x = a.replace(/^\.\//, "");
  const y = b.replace(/^\.\//, "");
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

export type InjectedItemUse = "used" | "unused" | "unscorable";

export function injectedItemUse(
  ref: InjectedRef,
  record: InjectionRecord,
  sessionObservations: CompressedObservation[],
): InjectedItemUse {
  const triggerFiles = record.files ?? [];
  const evidenceFiles = (ref.files ?? []).filter(
    (f) => !triggerFiles.some((t) => sameFile(f, t)),
  );
  if (evidenceFiles.length === 0) return "unscorable";
  const injectedAt = Date.parse(record.at);
  const used = sessionObservations.some(
    (o) =>
      o.sessionId === record.sessionId &&
      Date.parse(o.timestamp) > injectedAt &&
      ((o.files ?? []).some((f) => evidenceFiles.some((e) => sameFile(f, e))) ||
        `${o.subtitle ?? ""} ${o.narrative ?? ""}`.includes(ref.id)),
  );
  return used ? "used" : "unused";
}

async function getEach<T>(kv: StateKV, scope: string, ids: Iterable<string>): Promise<Map<string, T>> {
  const unique = [...new Set(ids)];
  const values = await Promise.all(unique.map((id) => kv.get<T>(scope, id)));
  return new Map(
    unique.flatMap((id, i) => (values[i] ? [[id, values[i] as T] as const] : [])),
  );
}

export async function resolveInsightFiles(
  kv: StateKV,
  records: InjectionRecord[],
): Promise<Map<string, string[]>> {
  const insightIds = records.flatMap((r) => r.injected.filter((ref) => ref.kind === "insight").map((ref) => ref.id));
  const insights = await getEach<Insight>(kv, KV.insights, insightIds);
  const all = [...insights.values()];
  const [memories, crystals] = await Promise.all([
    getEach<Memory>(kv, KV.memories, all.flatMap((i) => i.sourceMemoryIds ?? [])),
    getEach<Crystal>(kv, KV.crystals, all.flatMap((i) => i.sourceCrystalIds ?? [])),
  ]);
  return new Map(
    all.map((insight) => [
      insight.id,
      [
        ...new Set([
          ...(insight.sourceMemoryIds ?? []).flatMap((id) => memories.get(id)?.files ?? []),
          ...(insight.sourceCrystalIds ?? []).flatMap((id) => crystals.get(id)?.filesAffected ?? []),
        ]),
      ],
    ]),
  );
}

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
    const expired = records.filter((r) => Date.parse(r.at) < cutoff);
    await Promise.all(expired.map((r) => kv.delete(KV.injections, r.id)));
    if (expired.length > 0) {
      logger.info("Injection records swept", { swept: expired.length });
    }
    return { success: true, swept: expired.length };
  });
}
