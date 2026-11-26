import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerContextFunction } from "../../src/functions/context.js";
import { KV } from "../../src/state/schema.js";
import { mockKV, mockSdk } from "../../test/helpers/mocks.js";

type Patch = Record<string, { before: string; after: string }>;
type Check = { id: string; text: string; path: string; fails: (edit: Patch[string]) => boolean };
const pageText = "Set the catalog page size to 40.";
const amendedText = "Set the catalog page size to 60.";
const archiveText = "Leave the archive fixture unchanged.";
const styleText = "Keep the catalog naming clear.";
const cases: { name: string; patch: Patch; expected: string[]; amended?: true }[] = [
  { name: "wrong-page-size", patch: { "catalog.json": { before: '{"pageSize":40}', after: '{"pageSize":50}' } }, expected: ["page"] },
  { name: "right-page-size", patch: { "catalog.json": { before: '{"pageSize":30}', after: '{"pageSize":40}' } }, expected: [] },
  { name: "archive-change", patch: { "archive.json": { before: "{}", after: '{"rows":[]}' } }, expected: ["archive"] },
  { name: "unrelated-change", patch: { "readme.md": { before: "Hello", after: "Catalog" } }, expected: [] },
  { name: "amended-correct", patch: { "catalog.json": { before: '{"pageSize":40}', after: '{"pageSize":60}' } }, expected: [], amended: true },
  { name: "amended-wrong", patch: { "catalog.json": { before: '{"pageSize":60}', after: '{"pageSize":40}' } }, expected: ["page"], amended: true },
  { name: "unsupported", patch: { "readme.md": { before: "Catalog", after: "Miscellaneous items" } }, expected: ["style"] },
];

function pageCheck(text: string, size: number): Check {
  return { id: "page", text, path: "catalog.json", fails: ({ after }) => {
    try { return JSON.parse(after)?.pageSize !== size; } catch { return true; }
  } };
}

function advise(context: string, patch: Patch, checks: Check[]) {
  const lines = context.split("\n");
  return checks.filter(check => lines.includes(`- ${check.text}`) && Object.hasOwn(patch, check.path) && check.fails(patch[check.path])).map(check => check.id);
}

export async function runExperiment() {
  const initial = pageCheck(pageText, 40);
  const maintained = pageCheck(amendedText, 60);
  const archive: Check = { id: "archive", text: archiveText, path: "archive.json", fails: ({ before, after }) => before !== after };
  const project = "fixture";
  const pairs = [];
  let staleCheckOutput: string[] | undefined;
  for (const { name, patch, expected, amended } of cases) {
    const kv = mockKV();
    const sdk = mockSdk();
    const texts = { page: amended ? amendedText : pageText, archive: archiveText, style: styleText };
    for (const [id, content] of Object.entries(texts)) {
      await kv.set(KV.memories, id, { id, project, content, type: "rule", isLatest: true, updatedAt: "2026-11-24T00:00:00Z" });
    }
    registerContextFunction(sdk as never, { ...kv, writeGeneration: async () => 0 } as never, 400);
    const { context } = await sdk.trigger("mem::context", { sessionId: "next", project, budget: 400, agentId: "*" }) as { context: string };
    if (Object.values(texts).some(text => !context.includes(text))) throw new Error("Fixture Rule was not injected");
    const advisories = advise(context, patch, [amended ? maintained : initial, archive]);
    if (name === "amended-wrong") staleCheckOutput = advise(context, patch, [initial, archive]);
    pairs.push({ name, expected, baseline: [], advisories });
  }
  return { mappedRules: 2, rules: 3, translations: 2, maintenanceEdits: 1, staleCheckOutput, pairs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runExperiment(), null, 2));
