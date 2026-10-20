import type { Memory } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { STOP_WORDS } from "../state/stopwords.js";

// mem::remember supersedes only a near-restatement (Jaccard above 0.7), so a
// reversal worded differently leaves both Memories live. When one query pulls
// up two Memories of the same type and scope that share this much of their
// distinctive wording, they are two claims about one subject and the newer is
// the one that holds. Read-side only: nothing is marked or deleted, and the
// older one stays in the results, directly below the newer.
const MIN_SHARED_TERMS = 2;
const MIN_SHARED_OF_SMALLER = 0.3;

function distinctiveTerms(content: string): Set<string> {
  const terms = content.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return new Set(terms.filter((t) => !STOP_WORDS.has(t)));
}

function sameSubject(a: Set<string>, b: Set<string>): boolean {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared >= MIN_SHARED_TERMS && shared / Math.min(a.size, b.size) >= MIN_SHARED_OF_SMALLER;
}

// Maps each shadowed Memory id to the newest Memory that shadows it.
export async function shadowedMemoryIds(kv: StateKV, ids: string[]): Promise<Map<string, string>> {
  const loaded = await Promise.all(ids.map((id) => kv.get<Memory>(KV.memories, id).catch(() => null)));
  const memories = loaded
    .filter((m): m is Memory => m !== null)
    .map((memory) => ({ memory, terms: distinctiveTerms(memory.content) }));
  const shadowed = new Map<string, string>();
  for (const older of memories) {
    const newest = memories
      .filter(
        (n) =>
          n.memory.createdAt > older.memory.createdAt &&
          n.memory.type === older.memory.type &&
          (n.memory.global === true) === (older.memory.global === true) &&
          sameSubject(older.terms, n.terms),
      )
      .reduce<Memory | null>((a, n) => (!a || n.memory.createdAt > a.createdAt ? n.memory : a), null);
    if (newest) shadowed.set(older.memory.id, newest.id);
  }
  return shadowed;
}

// Puts each shadowing Memory directly above the older one it shadows. Only
// reorders: nothing is removed, and a Memory not in `items` is never added.
export function newerAboveShadowed<T>(items: T[], idOf: (item: T) => string, shadowed: Map<string, string>): T[] {
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const placed = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const id = idOf(item);
    if (placed.has(id)) continue;
    const newer = byId.get(shadowed.get(id) ?? "");
    if (newer && !placed.has(idOf(newer))) {
      out.push(newer);
      placed.add(idOf(newer));
    }
    out.push(item);
    placed.add(id);
  }
  return out;
}
