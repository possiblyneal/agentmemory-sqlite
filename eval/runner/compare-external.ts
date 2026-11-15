import { existsSync, readFileSync } from "node:fs";
import { readNdjson } from "./durable.js";
import { join, resolve } from "node:path";
import { mcnemarExact } from "./compare-core.js";
import { EXTERNAL_ARMS } from "./external-text.js";

// Reads tmp/ext396-style arm directories (<root>/arm-<arm>/{summary,scores}) and prints the
// scorecard table for #396: pooled and typical, plus a paired McNemar of each arm against none.

interface Summary {
  rightContent: { injectedItems: number; usedItems: number; usedShare: number | null; injectionChars: number; charsPerUsedItem: number | null };
  rightMoment: { keyItems: number; either: { hit: number; n: number } };
  leastRecord?: { storeBytes: number; bytesPerUsedItem: number | null };
  external?: Record<string, { injectedItems: number; usedItems: number; chars: number }>;
}
interface Run {
  summary: Summary;
  typical: Summary;
  delivered: Map<string, boolean>;
}

function load(root: string, arm: string): Run {
  const dir = join(root, `arm-${arm}`);
  const file = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as { summary: Summary & { typical: { summary: Summary } } };
  const delivered = new Map<string, boolean>();
  for (const s of readNdjson<{ sessionId: string; outcomes: Array<{ injected: boolean; searched: boolean }> }>(join(dir, "scores.ndjson")).rows) {
    s.outcomes.forEach((o, i) => delivered.set(`${s.sessionId}#${i}`, o.injected || o.searched));
  }
  return { summary: file.summary, typical: file.summary.typical.summary, delivered };
}

const pct = (x: number | null | undefined) => (x == null ? "-" : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null | undefined) => (x == null ? "-" : Math.round(x).toString());

function row(arm: string, s: Summary): string {
  const ext = s.external ?? {};
  const extUsed = Object.values(ext).reduce((n, e) => n + e.usedItems, 0);
  const extInj = Object.values(ext).reduce((n, e) => n + e.injectedItems, 0);
  const key = s.rightMoment.either;
  return `| ${arm} | ${key.hit}/${key.n} | ${s.rightContent.usedItems}/${s.rightContent.injectedItems} (${pct(s.rightContent.usedShare)}) | ${num(s.rightContent.charsPerUsedItem)} | ${num(s.leastRecord?.bytesPerUsedItem)} | ${extUsed}/${extInj} |`;
}

const root = resolve(process.argv[2] ?? "tmp/ext396");
const runs = EXTERNAL_ARMS.filter((a) => existsSync(join(root, `arm-${a}`, "summary.json"))).map((a) => [a, load(root, a)] as const);
const header = "| arm | key delivered | used / injected | chars per used item | store bytes per used item | external used / injected |\n| --- | --- | --- | --- | --- | --- |";
console.log(`### Pooled\n\n${header}\n${runs.map(([a, r]) => row(a, r.summary)).join("\n")}`);
console.log(`\n### Typical\n\n${header}\n${runs.map(([a, r]) => row(a, r.typical)).join("\n")}`);
const none = runs.find(([a]) => a === "none")?.[1];
if (none) {
  console.log("\n### Key items delivered, paired against none\n\n| arm | only arm | only none | exact McNemar p |\n| --- | --- | --- | --- |");
  for (const [a, r] of runs) {
    if (a === "none") continue;
    let armOnly = 0;
    let noneOnly = 0;
    for (const [k, v] of r.delivered) {
      const n = none.delivered.get(k);
      if (n === undefined) continue;
      if (v && !n) armOnly++;
      if (!v && n) noneOnly++;
    }
    console.log(`| ${a} | ${armOnly} | ${noneOnly} | ${mcnemarExact(armOnly, noneOnly).toFixed(4)} |`);
  }
}
