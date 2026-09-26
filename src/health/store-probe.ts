import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";

export async function storeAcceptsWrite(kv: StateKV, key: string): Promise<boolean> {
  const probe = { ts: Date.now() };
  return kv
    .set(KV.health, key, probe)
    .then(() => kv.get<{ ts?: number }>(KV.health, key))
    .then((back) => back?.ts === probe.ts)
    .catch(() => false);
}
