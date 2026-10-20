// Supersession fixtures: for each record kind and Injection surface the docs
// table names (docs/supersession.md), eight lexical pairs where a newer claim
// contradicts an older one. Each case is its own project, so one sandbox holds
// them all. Rows are seeded into the store before the daemon boots (so the
// boot rebuild indexes them, as after a restart); steps then go through REST,
// because Memories and Lessons are supersession-checked on save.

import { KV } from "../../src/state/schema.js";
import type { Kind, Surface } from "./supersession-score.js";

export interface Pair {
  id: string;
  topic: string;
  act: string;
  stale: string;
  fresh: string;
}

export const PAIRS: Pair[] = [
  { id: "tabs", topic: "whitespace rule", act: "indent with", stale: "tabs", fresh: "spaces" },
  { id: "pkg", topic: "package manager rule", act: "install packages with", stale: "yarn", fresh: "pnpm" },
  { id: "test", topic: "test runner rule", act: "run unit tests with", stale: "jest", fresh: "vitest" },
  { id: "land", topic: "landing rule", act: "land branches by", stale: "merging", fresh: "squashing" },
  { id: "store", topic: "session storage rule", act: "store sessions in", stale: "postgres", fresh: "redis" },
  { id: "naming", topic: "naming rule", act: "name variables in", stale: "camelCase", fresh: "snake_case" },
  { id: "lint", topic: "linting rule", act: "lint code with", stale: "eslint", fresh: "biome" },
  { id: "http", topic: "http client rule", act: "call services with", stale: "axios", fresh: "undici" },
];

export interface SeedRow {
  scope: string;
  key: string;
  value: unknown;
}

// Steps run after boot, in order. `evolve` replaces the Memory the latest
// `remember` stored.
export type Step =
  | { op: "remember"; content: string }
  | { op: "lesson"; content: string }
  | { op: "evolve"; newContent: string };

export type SearchList = "results" | "lessons" | "insights" | "semanticFacts";

export type Probe =
  | { via: "search"; query: string; list: SearchList }
  | { via: "context" }
  | { via: "prompt"; prompt: string };

export interface EvalCase {
  id: string;
  group: string;
  kind: Kind;
  variant: string;
  surface: Surface;
  project: string;
  rows: SeedRow[];
  steps: Step[];
  probe: Probe;
  stale: string;
  fresh: string;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

interface Clock {
  old: string;
  afterOld: string;
  fresh: string;
  afterFresh: string;
  lateWrite: string;
  earlyWrite: string;
  startNow: string;
}

function clockAt(now: Date): Clock {
  const ago = (days: number, hours = 0) => new Date(now.getTime() - days * DAY_MS + hours * HOUR_MS).toISOString();
  return {
    old: ago(50),
    afterOld: ago(50, 1),
    fresh: ago(10),
    afterFresh: ago(10, 1),
    lateWrite: ago(5),
    earlyWrite: ago(9),
    startNow: new Date(now.getTime() - 3 * HOUR_MS).toISOString(),
  };
}

const claim = (p: Pair, word: string) => `${p.act} ${word}`;

function sessionRow(id: string, project: string, startedAt: string): SeedRow {
  return {
    scope: KV.sessions,
    key: id,
    value: { id, project, cwd: `/work/${project}`, startedAt, status: "completed", observationCount: 1 },
  };
}

function observationRow(
  id: string,
  sessionId: string,
  timestamp: string,
  title: string,
  narrative: string,
): SeedRow {
  return {
    scope: KV.observations(sessionId),
    key: id,
    value: { id, sessionId, timestamp, type: "decision", title, facts: [], narrative, concepts: [], files: [], importance: 6 },
  };
}

function summaryRow(
  sessionId: string,
  project: string,
  decision: string,
  createdAt: string,
  lastObservationAt: string,
): SeedRow {
  return {
    scope: KV.summaries,
    key: sessionId,
    value: {
      sessionId,
      project,
      createdAt,
      title: `Work ${sessionId}`,
      narrative: "n",
      keyDecisions: [decision],
      filesModified: [],
      concepts: [],
      observationCount: 1,
      coveredThrough: createdAt,
      lastObservationAt,
    },
  };
}

function semanticRow(id: string, fact: string, confidence: number, createdAt: string, sessionId: string): SeedRow {
  return {
    scope: KV.semantic,
    key: id,
    value: {
      id,
      fact,
      confidence,
      sourceSessionIds: [sessionId],
      sourceMemoryIds: [],
      accessCount: 1,
      lastAccessedAt: createdAt,
      strength: confidence,
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function insightRow(id: string, project: string, title: string, content: string, confidence: number, createdAt: string): SeedRow {
  return {
    scope: KV.insights,
    key: id,
    value: {
      id,
      title,
      content,
      confidence,
      reinforcements: 0,
      sourceConceptCluster: [],
      sourceMemoryIds: [],
      sourceLessonIds: [],
      sourceCrystalIds: [],
      project,
      tags: [],
      createdAt,
      updatedAt: createdAt,
      decayRate: 0.05,
    },
  };
}

interface Cell {
  kind: Kind;
  variant: string;
  surface: Surface;
  make(p: Pair, project: string, c: Clock): Omit<EvalCase, "id" | "group" | "kind" | "variant" | "surface" | "project">;
}

// A Memory title is its first 80 characters and search results carry only the
// title, so every Memory text stays under that.
const restatedA = (p: Pair) => `Always ${claim(p, p.stale)} in this repository, never ${p.fresh}`;
const restatedB = (p: Pair) => `Always ${claim(p, p.fresh)} in this repository, never ${p.stale}`;
const contradictedA = (p: Pair) => `Convention for the ${p.topic}: ${claim(p, p.stale)}`;
const contradictedB = (p: Pair) => `Decision: ${p.fresh} now mandatory for the ${p.topic}, ${p.stale} banned`;

const searchQuery = (p: Pair) => `${p.act} ${p.stale} ${p.fresh} repository`;
const promptFor = (p: Pair) => `what is the ${p.topic}, should we ${p.act} ${p.stale} or ${p.fresh} in every source file of the repository`;

function base(project: string, c: Clock): SeedRow[] {
  return [
    sessionRow(`${project}-a`, project, c.old),
    sessionRow(`${project}-b`, project, c.fresh),
    sessionRow(`${project}-now`, project, c.startNow),
  ];
}

function memoryCell(variant: string, surface: "search" | "prompt-submit", texts: (p: Pair) => [string, string], evolve: boolean): Cell {
  return {
    kind: "memory",
    variant,
    surface,
    make: (p, project, c) => {
      const [a, b] = texts(p);
      return {
        rows: base(project, c),
        steps: evolve
          ? [{ op: "remember", content: a }, { op: "evolve", newContent: b }]
          : [{ op: "remember", content: a }, { op: "remember", content: b }],
        probe:
          surface === "search"
            ? { via: "search", query: searchQuery(p), list: "results" }
            : { via: "prompt", prompt: promptFor(p) },
        stale: a,
        fresh: b,
      };
    },
  };
}

function surfaceProbe(surface: Surface, p: Pair, query: string, list: SearchList): Probe {
  if (surface === "search") return { via: "search", query, list };
  if (surface === "session-start") return { via: "context" };
  return { via: "prompt", prompt: promptFor(p) };
}

function semanticCell(surface: "search" | "session-start"): Cell {
  return {
    kind: "semantic-fact",
    variant: "reinforced",
    surface,
    make: (p, project, c) => {
      const stale = `The team agreed to ${claim(p, p.stale)}`;
      const fresh = `The team agreed to ${claim(p, p.fresh)}`;
      return {
        rows: [
          ...base(project, c),
          semanticRow(`sem_${project}_a`, stale, 0.8, c.old, `${project}-a`),
          semanticRow(`sem_${project}_b`, fresh, 0.7, c.fresh, `${project}-b`),
        ],
        steps: [],
        probe: surfaceProbe(surface, p, `agreed ${p.act} ${p.stale} ${p.fresh}`, "semanticFacts"),
        stale,
        fresh,
      };
    },
  };
}

// A Lesson is saved under a fingerprint of its text, whatever the project, so
// each cell words its Lessons differently or a later cell would only
// strengthen an earlier cell's row.
function lessonCell(surface: "search" | "session-start"): Cell {
  const saved = surface === "search" ? "when looking things up" : "when a Session starts";
  return {
    kind: "lesson",
    variant: "reinforced",
    surface,
    make: (p, project, c) => {
      const stale = `Rule: ${claim(p, p.stale)}`;
      const fresh = `Rule: ${claim(p, p.fresh)}`;
      return {
        rows: base(project, c),
        steps: [
          { op: "lesson", content: `${stale} ${saved}` },
          { op: "lesson", content: `${stale} ${saved}` },
          { op: "lesson", content: `${stale} ${saved}` },
          { op: "lesson", content: `${fresh} ${saved}` },
        ],
        probe: surfaceProbe(surface, p, `rule ${p.act} ${p.stale} ${p.fresh}`, "lessons"),
        stale,
        fresh,
      };
    },
  };
}

function insightCell(surface: "search" | "session-start"): Cell {
  return {
    kind: "insight",
    variant: "reinforced",
    surface,
    make: (p, project, c) => {
      const stale = `Team will ${claim(p, p.stale)}`;
      const fresh = `Team will ${claim(p, p.fresh)}`;
      return {
        rows: [
          ...base(project, c),
          insightRow(`ins_${project}_a`, project, p.topic, stale, 0.8, c.old),
          insightRow(`ins_${project}_b`, project, p.topic, fresh, 0.5, c.fresh),
        ],
        steps: [],
        probe: surfaceProbe(surface, p, `${p.topic} ${p.act} ${p.stale} ${p.fresh}`, "insights"),
        stale,
        fresh,
      };
    },
  };
}

function settledObservations(p: Pair, project: string, c: Clock): SeedRow[] {
  const staleNarrative = `Settled the ${p.topic}: ${claim(p, p.stale)} everywhere in the repository`;
  const freshNarrative = `Reversed the ${p.topic}: ${claim(p, p.fresh)} everywhere in the repository`;
  return [
    observationRow(`obs_${project}_a`, `${project}-a`, c.old, staleNarrative, staleNarrative),
    observationRow(`obs_${project}_b`, `${project}-b`, c.fresh, freshNarrative, freshNarrative),
  ];
}

function summaryCell(
  variant: string,
  surface: "session-start" | "prompt-submit",
  times: (c: Clock) => { old: string; fresh: string },
): Cell {
  return {
    kind: "summary-decision",
    variant,
    surface,
    make: (p, project, c) => {
      const stale = `Rule: ${claim(p, p.stale)}`;
      const fresh = `Rule: ${claim(p, p.fresh)}`;
      const written = times(c);
      return {
        rows: [
          ...base(project, c),
          ...settledObservations(p, project, c),
          summaryRow(`${project}-a`, project, stale, written.old, c.old),
          summaryRow(`${project}-b`, project, fresh, written.fresh, c.fresh),
        ],
        steps: [],
        probe: surfaceProbe(surface, p, "", "results"),
        stale,
        fresh,
      };
    },
  };
}

const summaryVsMemoryCell: Cell = {
  kind: "summary-decision",
  variant: "against-memory",
  surface: "prompt-submit",
  make: (p, project, c) => {
    const stale = `Rule: ${claim(p, p.stale)}`;
    const fresh = `${p.topic} reversed, ${claim(p, p.fresh)} everywhere in the repository`;
    return {
      rows: [
        ...base(project, c),
        settledObservations(p, project, c)[0],
        summaryRow(`${project}-a`, project, stale, c.afterOld, c.old),
      ],
      steps: [{ op: "remember", content: fresh }],
      probe: { via: "prompt", prompt: promptFor(p) },
      stale,
      fresh,
    };
  },
};

function observationCell(variant: "equal" | "stronger", surface: Surface): Cell {
  return {
    kind: "observation",
    variant,
    surface,
    make: (p, project, c) => {
      const stale = claim(p, p.stale);
      const fresh = claim(p, p.fresh);
      const rows = [
        ...base(project, c),
        observationRow(`obs_${project}_a`, `${project}-a`, c.old, `${p.topic}: ${stale}`, `${p.topic}: we ${stale} in every source file of the repository`),
        observationRow(`obs_${project}_b`, `${project}-b`, c.fresh, `${p.topic}: ${fresh}`, `${p.topic}: we ${fresh} in every source file of the repository`),
      ];
      if (variant === "stronger") {
        rows.push(
          observationRow(
            `obs_${project}_a2`,
            `${project}-a`,
            c.old,
            `${p.topic}: ${stale}`,
            `${p.topic} ${p.topic}: we ${stale}, ${stale}, never ${p.fresh}, ${p.stale} ${p.stale} ${p.stale} in every source file of the repository`,
          ),
        );
      }
      return {
        rows,
        steps: [],
        probe: surfaceProbe(surface, p, `${p.topic} ${p.act} ${p.stale} ${p.fresh} source file`, "results"),
        stale,
        fresh,
      };
    },
  };
}

const CELLS: Cell[] = [
  memoryCell("restated", "search", (p) => [restatedA(p), restatedB(p)], false),
  memoryCell("restated", "prompt-submit", (p) => [restatedA(p), restatedB(p)], false),
  memoryCell("contradicted", "search", (p) => [contradictedA(p), contradictedB(p)], false),
  memoryCell("contradicted", "prompt-submit", (p) => [contradictedA(p), contradictedB(p)], false),
  memoryCell("evolved", "search", (p) => [restatedA(p), restatedB(p)], true),
  memoryCell("evolved", "prompt-submit", (p) => [restatedA(p), restatedB(p)], true),
  semanticCell("search"),
  semanticCell("session-start"),
  lessonCell("search"),
  lessonCell("session-start"),
  insightCell("search"),
  insightCell("session-start"),
  summaryCell("work-order", "session-start", (c) => ({ old: c.afterOld, fresh: c.afterFresh })),
  summaryCell("work-order", "prompt-submit", (c) => ({ old: c.afterOld, fresh: c.afterFresh })),
  summaryCell("written-early", "session-start", (c) => ({ old: c.lateWrite, fresh: c.earlyWrite })),
  summaryVsMemoryCell,
  observationCell("equal", "search"),
  observationCell("equal", "session-start"),
  observationCell("equal", "prompt-submit"),
  observationCell("stronger", "search"),
  observationCell("stronger", "session-start"),
  observationCell("stronger", "prompt-submit"),
];

export function buildCases(now: Date): EvalCase[] {
  const clock = clockAt(now);
  return CELLS.flatMap((cell) =>
    PAIRS.map((pair): EvalCase => {
      const group = `${cell.kind}/${cell.variant}/${cell.surface}`;
      const project = `ss-${group.replace(/\//g, "-")}-${pair.id}`;
      return {
        id: `${group}/${pair.id}`,
        group,
        kind: cell.kind,
        variant: cell.variant,
        surface: cell.surface,
        project,
        ...cell.make(pair, project, clock),
      };
    }),
  );
}
