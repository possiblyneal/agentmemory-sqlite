import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? ".");
const { registerLessonsFunctions, searchLessons } = await import(pathToFileURL(resolve(root, "src/functions/lessons.ts")).href);
const now = "2026-11-22T00:00:00.000Z";
const target = {
  id: "target", content: "quartz deployment with additional details for our project", context: "",
  confidence: 0.9, reinforcements: 0, source: "manual", sourceIds: [], project: "/app",
  tags: [], createdAt: now, updatedAt: now, decayRate: 0.01,
};
const rows = [target, ...Array.from({ length: 200 }, (_, i) => ({
  ...target, id: `foreign-${i}`, project: "/other", content: "quartz deployment",
}))];
const kv = { list: async () => rows, set: async () => {} };
const handlers = new Map<string, Function>();
registerLessonsFunctions({ registerFunction: (id: string, handler: Function) => handlers.set(id, handler) }, kv);
const candidate = await searchLessons(kv, "quartz deployment", "/app", 1);
const recall = await handlers.get("mem::lesson-recall")!({ query: "quartz deployment", project: "/app", limit: 1 });
for (const [path, lessons] of [["candidate", candidate], ["recall", recall.lessons]] as const) {
  const ids = lessons.map((lesson: { id: string }) => lesson.id);
  console.log(`${path}: expected=target actual=${ids.join(",") || "<empty>"} hit=${ids.includes("target") ? 1 : 0}`);
}
