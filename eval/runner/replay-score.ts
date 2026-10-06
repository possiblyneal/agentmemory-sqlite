import {
  MIN_SHARED_TOKENS,
  bearsOn,
  contentTokens,
  sharedTokens,
  type AnswerKey,
  type KeyItem,
} from "./replay-answer-key.js";
import { INJECT_TIMEOUT_MS } from "../../src/hooks/_missed-injection.js";
import { touchedFiles, type ReplaySession } from "./replay-transcript.js";

export type ProbeKind = "session-start" | "prompt-context" | "search";

export type ItemKind = "observation" | "summary" | "lesson" | "memory";

export interface ProbeItem {
  ref: string;
  kind: ItemKind;
  sessionId?: string;
  project?: string;
  files: string[];
  text: string;
}

export interface Probe {
  kind: ProbeKind;
  turn: number;
  latencyMs: number;
  chars: number;
  items: ProbeItem[];
  failed?: boolean;
}

export interface ScoredItem {
  ref: string;
  kind: ItemKind;
  firstTurn: number;
  used: boolean;
  leak: boolean;
  project?: string;
  chars: number;
  excerpt: string;
}

export interface KeyOutcome {
  key: KeyItem;
  injected: boolean;
  searched: boolean;
}

export interface SessionScore {
  sessionId: string;
  project: string;
  startedAt: string;
  turns: number;
  failedProbes: number;
  injectionChars: number;
  items: ScoredItem[];
  outcomes: KeyOutcome[];
  latencies: Array<{ kind: ProbeKind; ms: number }>;
}

// An earlier correction or decision is delivered when most of its words are in
// the injected item.
const MIN_DELIVERY_COVERAGE = 0.6;

function delivers(item: ProbeItem, key: KeyItem): boolean {
  if (key.kind === "file") return item.files.includes(key.file);
  const wanted = contentTokens(key.earlierText);
  const got = contentTokens(item.text);
  return sharedTokens(wanted, got) >= MIN_SHARED_TOKENS && sharedTokens(wanted, got) / wanted.size >= MIN_DELIVERY_COVERAGE;
}

// The last probe that can still help. A repeated correction means the Agent
// went wrong on the prompt before it, so its own prompt's Injection is late.
function deadline(key: KeyItem): number {
  return key.kind === "correction" ? key.turn - 1 : key.turn;
}

function deliveredBy(probes: Probe[], key: KeyItem, injection: boolean): boolean {
  return probes.some(
    (p) => (p.kind !== "search") === injection && p.turn <= deadline(key) && p.items.some((i) => delivers(i, key)),
  );
}

function itemUsed(item: ProbeItem, session: ReplaySession, key: AnswerKey): boolean {
  const touched = touchedFiles(session);
  return (
    item.files.some((f) => touched.has(f)) ||
    [...key.files, ...key.corrections, ...key.decisions].some((k) => delivers(item, k)) ||
    session.userTurns.some((t) => bearsOn(item.text, t.text))
  );
}

export function scoreSession(session: ReplaySession, key: AnswerKey, probes: Probe[]): SessionScore {
  const injections = probes.filter((p) => p.kind !== "search");
  const first = new Map<string, { item: ProbeItem; turn: number }>();
  for (const p of injections) {
    for (const item of p.items) if (!first.has(item.ref)) first.set(item.ref, { item, turn: p.turn });
  }
  const items = [...first.values()].map(({ item, turn }) => ({
    ref: item.ref,
    kind: item.kind,
    firstTurn: turn,
    used: itemUsed(item, session, key),
    leak: item.project !== undefined && item.project !== session.project,
    project: item.project,
    chars: item.text.length,
    excerpt: item.text.slice(0, 160),
  }));
  const keys: KeyItem[] = [...key.files, ...key.corrections, ...key.decisions];
  return {
    sessionId: session.id,
    project: session.project,
    startedAt: session.startedAt,
    turns: session.userTurns.length,
    failedProbes: probes.filter((p) => p.failed).length,
    injectionChars: injections.reduce((n, p) => n + p.chars, 0),
    items,
    outcomes: keys.map((k) => ({
      key: k,
      injected: deliveredBy(probes, k, true),
      searched: deliveredBy(probes, k, false),
    })),
    latencies: probes.filter((p) => !p.failed).map((p) => ({ kind: p.kind, ms: p.latencyMs })),
  };
}

export interface RunMeta {
  storeBytesStart: number;
  storeBytesEnd: number;
}

interface Share {
  n: number;
  hit: number;
  share: number | null;
}

function share(hit: number, n: number): Share {
  return { n, hit, share: n === 0 ? null : hit / n };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

const DAY_MS = 86_400_000;

export function summarizeReplay(scores: SessionScore[], meta: RunMeta) {
  const items = scores.flatMap((s) => s.items);
  const outcomes = scores.flatMap((s) => s.outcomes);
  const kinds = ["file", "correction", "decision"] as const;
  const byKind = Object.fromEntries(
    kinds.map((kind) => {
      const of = outcomes.filter((o) => o.key.kind === kind);
      return [
        kind,
        {
          injection: share(of.filter((o) => o.injected).length, of.length),
          search: share(of.filter((o) => o.searched).length, of.length),
          either: share(of.filter((o) => o.injected || o.searched).length, of.length),
        },
      ];
    }),
  );
  const corrections = outcomes.filter((o) => o.key.kind === "correction");
  const injectionChars = scores.reduce((n, s) => n + s.injectionChars, 0);
  const used = items.filter((i) => i.used);
  const usedRefs = new Set(used.map((i) => i.ref));
  const probeKinds: ProbeKind[] = ["session-start", "prompt-context", "search"];
  const starts = scores.map((s) => Date.parse(s.startedAt)).filter((t) => !Number.isNaN(t));
  const spanDays = starts.length === 0 ? 0 : (Math.max(...starts) - Math.min(...starts)) / DAY_MS;
  const weeks = Math.max(spanDays, 1) / 7;
  const growth = meta.storeBytesEnd - meta.storeBytesStart;
  return {
    sessions: scores.length,
    failedProbes: scores.reduce((n, s) => n + s.failedProbes, 0),
    rightContent: {
      injectedItems: items.length,
      usedItems: used.length,
      usedShare: items.length === 0 ? null : used.length / items.length,
      injectionChars,
      charsPerUsedItem: used.length === 0 ? null : injectionChars / used.length,
    },
    rightMoment: {
      keyItems: outcomes.length,
      injection: share(outcomes.filter((o) => o.injected).length, outcomes.length),
      search: share(outcomes.filter((o) => o.searched).length, outcomes.length),
      either: share(outcomes.filter((o) => o.injected || o.searched).length, outcomes.length),
      byKind,
    },
    rightScope: {
      injectedItems: items.length,
      leaks: items.filter((i) => i.leak).length,
    },
    durableBeatsRecent: {
      repeatedCorrections: corrections.length,
      injectedBeforeRepeat: corrections.filter((o) => o.injected).length,
      share: corrections.length === 0 ? null : corrections.filter((o) => o.injected).length / corrections.length,
    },
    leastRecord: {
      storeBytes: meta.storeBytesEnd,
      distinctUsedItems: usedRefs.size,
      bytesPerUsedItem: usedRefs.size === 0 ? null : meta.storeBytesEnd / usedRefs.size,
    },
    criticalPath: Object.fromEntries(
      probeKinds.map((kind) => {
        const ms = scores
          .flatMap((s) => s.latencies)
          .filter((l) => l.kind === kind)
          .map((l) => l.ms)
          .sort((a, b) => a - b);
        return [
          kind,
          {
            n: ms.length,
            p50: percentile(ms, 0.5),
            p99: percentile(ms, 0.99),
            overHookTimeout: ms.filter((m) => m > INJECT_TIMEOUT_MS).length,
          },
        ];
      }),
    ),
    operatorAttention: {
      replayedWeeks: weeks,
      storeGrowthBytes: growth,
      growthBytesPerWeek: growth / weeks,
    },
  };
}

export type ReplaySummary = ReturnType<typeof summarizeReplay>;

export interface WorstCase {
  category: "miss" | "noise" | "leak";
  sessionId: string;
  turn: number;
  detail: string;
}

const MISS_SEVERITY: Record<KeyItem["kind"], number> = { correction: 3, decision: 2, file: 1 };

// Misses rank by how costly the Operator found them, noise by how much it cost
// the Agent to read, and leaks are all equal.
const WORST_PER_CATEGORY = 20;

export function worstCases(scores: SessionScore[]): WorstCase[] {
  const misses = scores
    .flatMap((s) => s.outcomes.filter((o) => !o.injected).map((o) => ({ s, o })))
    .sort(
      (a, b) =>
        MISS_SEVERITY[b.o.key.kind] - MISS_SEVERITY[a.o.key.kind] ||
        (b.o.key.kind === "file" ? b.o.key.earlierSessionIds.length : 0) -
          (a.o.key.kind === "file" ? a.o.key.earlierSessionIds.length : 0),
    )
    .slice(0, WORST_PER_CATEGORY)
    .map(({ s, o }) => ({
      category: "miss" as const,
      sessionId: s.sessionId,
      turn: o.key.turn,
      detail:
        o.key.kind === "file"
          ? `file ${o.key.file} touched by ${o.key.earlierSessionIds.length} earlier Session(s); search found it: ${o.searched}`
          : `${o.key.kind} "${o.key.text.slice(0, 200)}" echoes earlier turn ${o.key.earlierTurn} of Session ${o.key.earlierSessionId}: "${o.key.earlierText.slice(0, 200)}"; search found it: ${o.searched}`,
    }));
  const noise = scores
    .flatMap((s) => s.items.filter((i) => !i.used && !i.leak).map((i) => ({ s, i })))
    .sort((a, b) => b.i.chars - a.i.chars)
    .slice(0, WORST_PER_CATEGORY)
    .map(({ s, i }) => ({
      category: "noise" as const,
      sessionId: s.sessionId,
      turn: i.firstTurn,
      detail: `${i.kind} ${i.ref} injected and unused: "${i.excerpt}"`,
    }));
  const leaks = scores
    .flatMap((s) => s.items.filter((i) => i.leak).map((i) => ({ s, i })))
    .slice(0, WORST_PER_CATEGORY)
    .map(({ s, i }) => ({
      category: "leak" as const,
      sessionId: s.sessionId,
      turn: i.firstTurn,
      detail: `${i.kind} ${i.ref} from project ${i.project} injected into project ${s.project}: "${i.excerpt}"`,
    }));
  return [...misses, ...noise, ...leaks];
}
