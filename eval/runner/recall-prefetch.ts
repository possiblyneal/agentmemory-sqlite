import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Event = { kind: "tool" | "prompt"; at: number; id: string; session: string; project: string; query: string; version: number };
const event = (kind: Event["kind"], at: number, id: string, session: string, query = "catalog", version = 1, project = "local"): Event =>
  ({ kind, at, id, session, query, version, project });
const events = [
  event("tool", 0, "from-a", "a"),
  event("prompt", 3, "busy-b", "b"),
  event("prompt", 8, "busy-c", "c"),
  event("prompt", 10, "busy-a", "a"),
  event("tool", 24, "from-quiet", "quiet"),
  event("prompt", 32, "quiet", "quiet"),
  event("tool", 42, "from-stale", "stale"),
  event("prompt", 50, "stale", "stale", "catalog", 2),
  event("tool", 60, "from-mismatch", "mismatch", "catalog", 1, "other"),
  event("prompt", 68, "mismatch", "mismatch", "archive"),
  event("tool", 78, "unused", "ended"),
];
const SEARCH_TIME = 6;
const DEADLINE = 7;

function replay(prefetch: boolean) {
  let laneFreeAt = 0;
  let searches = 0;
  const cache = new Map<string, { event: Event; readyAt: number; used: boolean }>();
  const prompts = [];
  function enqueue(at: number) {
    searches++;
    laneFreeAt = Math.max(at, laneFreeAt) + SEARCH_TIME;
    return laneFreeAt;
  }
  for (const input of events) {
    if (input.kind === "tool") {
      if (prefetch) cache.set(input.session, { event: input, readyAt: enqueue(input.at), used: false });
      continue;
    }
    const candidate = cache.get(input.session);
    const reused = !!candidate && candidate.readyAt <= input.at && candidate.event.query === input.query &&
      candidate.event.project === input.project && candidate.event.version === input.version;
    if (reused) candidate.used = true;
    const elapsed = reused ? 0 : enqueue(input.at) - input.at;
    prompts.push({ id: input.id, elapsed, reused, timely: elapsed <= DEADLINE });
  }
  return { prompts, searches, searchTime: searches * SEARCH_TIME, discarded: [...cache.values()].filter(candidate => !candidate.used).length };
}

export function runExperiment() {
  return { baseline: replay(false), prefetch: replay(true) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(runExperiment(), null, 2));
