import { pathToFileURL } from "node:url";
import { resetLessonIndex, searchLessons } from "../../src/functions/lessons.js";
import type { StateKV } from "../../src/state/kv.js";
import type { Lesson } from "../../src/types.js";

const date = "2026-01-01T00:00:00.000Z";
function lesson(id: string, content: string, tags: string[], project = "alpha"): Lesson {
  return { id, content, context: "", tags, project, confidence: 1, reinforcements: 0, source: "manual", sourceIds: [], createdAt: date, updatedAt: date, decayRate: 0 };
}

const lessons = [
  lesson("directory", "Repair cache behavior repair cache behavior repair cache behavior", ["src/cache"]),
  lesson("exact", "Repair cache behavior with checksums and atomic writes", ["src/cache/store.ts"]),
  lesson("guidance", "Atomic writes atomic writes atomic writes: check directory transactions", ["src/cache"]),
  lesson("foreign", "Repair cache behavior repair cache behavior repair cache behavior", ["src/cache/store.ts"], "beta"),
];

type Case = "win" | "directory-needed" | "no-path" | "different-path";
export async function rankPair(name: Case): Promise<{ control: string[]; treatment: string[]; pool: string[] }> {
  resetLessonIndex();
  const kv = { list: async () => lessons } as unknown as StateKV;
  const ranked = await searchLessons(kv, name === "directory-needed" ? "atomic writes" : "repair cache behavior", "alpha", 10);
  const path = name === "no-path" ? undefined : name === "different-path" ? "src/cache/store.ts.bak" : "src/cache/store.ts";
  const treatment = path ? [...ranked].sort((a, b) => Number(b.tags.includes(path)) - Number(a.tags.includes(path))) : ranked;
  return { control: ranked.slice(0, 1).map((l) => l.id), treatment: treatment.slice(0, 1).map((l) => l.id), pool: ranked.map((l) => l.id) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const name of ["win", "directory-needed", "no-path", "different-path"] as const) {
    console.log(name, await rankPair(name));
  }
}
