import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Note = { key: string; value: string; why?: string };
const checkout = JSON.stringify({ pageSize: "40", reportFormat: "json" });
const notes: Note[] = [
  { key: "pageSize", value: "40" },
  { key: "reportFormat", value: "json" },
  { key: "archiveOverride", value: "keep-csv", why: "The archive reader accepts only CSV; new reports may still use JSON." },
  { key: "sortChange", value: "decline", why: "Stable ordering is part of the fixture snapshot contract." },
];
const tasks = [
  { name: "page-size", key: "pageSize", expected: "40" },
  { name: "report-format", key: "reportFormat", expected: "json" },
  { name: "archive-format", key: "archiveOverride", expected: "keep-csv" },
  { name: "order-change", key: "sortChange", expected: "decline" },
  { name: "unknown", key: "timezone", expected: "defer" },
];

export function runExperiment() {
  const rationale = notes.filter(note => note.why);
  const policies = [{ name: "checkout", notes: [] }, { name: "full", notes }, { name: "rationale", notes: rationale }];
  const rows = tasks.map(task => ({ name: task.name, arms: policies.map(policy => {
    const start = performance.now();
    const note = policy.notes.find(note => note.key === task.key);
    const checked = note ? undefined : JSON.parse(checkout) as Record<string, string>;
    const result = note?.value ?? checked?.[task.key] ?? "defer";
    return { policy: policy.name, correct: result === task.expected, reads: Number(!note), commands: 0, ms: performance.now() - start };
  }) }));
  return { rows, fullBytes: Buffer.byteLength(JSON.stringify(notes)), rationaleBytes: Buffer.byteLength(JSON.stringify(rationale)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(runExperiment(), null, 2));
