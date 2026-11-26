import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { estimateTokens } from "../../src/utils/tokens.js";

const surfaces = ["startup", "prompt"] as const;
type Surface = typeof surfaces[number];
type Record = { key: string; surface: Surface; project: string; availableAt: number; text: string };

function replay(project: string, slots: number, shift: number, required: Record["key"][]) {
  const store: Record[] = surfaces.flatMap((surface, i) => Array.from({ length: 6 }, (_, rank) => {
    const key = `${i}${rank}`;
    return { key, surface, project, availableAt: i, text: `Synthetic decision ${key}.\n` };
  }));
  store.unshift(
    { ...store[0]!, project: "foreign" },
    { ...store[0]!, availableAt: 2 },
  );
  const cost = estimateTokens(store[0]!.text);
  const startup = Math.max(1, Math.round(slots * 2 / 3) - shift);
  const pack = (surface: Surface, turn: number, quota: number) => store
    .filter((record) => record.surface === surface && record.project === project && record.availableAt <= turn)
    .slice(0, quota);
  const a = pack("startup", 0, startup);
  const b = pack("prompt", 1, slots - startup);
  const shown = [...a, ...b];
  return {
    correct: { startup: a.filter((record) => required.includes(record.key)).length, prompt: b.filter((record) => required.includes(record.key)).length },
    foreign: shown.some((record) => record.project !== project),
    future: a.some((record) => record.availableAt > 0) || b.some((record) => record.availableAt > 1),
    tokens: shown.length * cost,
    bytes: Buffer.byteLength(JSON.stringify(store)),
  };
}

export function runExperiment() {
  const development = ["fit-a", "fit-b"].map((project) => ({ project, required: ["00", "11", "12", "13"] }));
  const trained = [0, 1, 2].map((shift) => ({ shift, score: development.reduce((n, row) => {
    const { correct } = replay(row.project, 5, shift, row.required);
    return n + correct.startup + correct.prompt;
  }, 0) }));
  const best = [...trained].sort((a, b) => b.score - a.score)[0]!;
  const pairs = [4, 6].map((slots) => {
    const project = `test-${slots}`;
    const required = ["01", "11", "12"];
    return { slots, baseline: replay(project, slots, 0, required), treatment: replay(project, slots, best.shift, required) };
  });
  return { trained, learned: best.shift, pairs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(runExperiment(), null, 2));
