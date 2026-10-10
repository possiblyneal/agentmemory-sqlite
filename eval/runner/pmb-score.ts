// PrecisionMemBench scoring, ported from upstream's scoreCases by way of the
// agent-memory-benchmark port (eval/data/precisionmembench/README.md). Only
// relevantBeliefs comes from the daemon; pinned facts, open questions and the
// persona prelude are derived from the seed, as upstream does.

export interface Belief {
  _id: string;
  user_id: string;
  type: string;
  canonical_name?: string;
  aliases?: string[];
  content?: string;
  why_it_matters?: string;
  scope?: string[];
  pinned?: boolean;
  superseded_by?: string | null;
  resolved_at?: string | null;
  participants?: string[];
}

interface IdAssertions {
  mustInclude?: string[];
  mustExclude?: string[];
}

export interface PmbCase {
  caseId: string;
  category: string;
  scope: string[];
  query: string;
  userId?: string;
  budget?: Partial<Budget>;
  expect: {
    relevantBeliefs?: IdAssertions & {
      shouldInclude?: string[];
      shouldOnlyInclude?: string[];
      maxCount?: number;
      minCount?: number;
      orderedBefore?: Array<[string, string]>;
    };
    pinnedFacts?: IdAssertions;
    openQuestions?: IdAssertions;
    personaPrelude?: { nonEmpty?: boolean; isNull?: boolean; contains?: string[]; mustNotContain?: string[] };
  };
}

interface Budget {
  maxBeliefs: number;
  maxPinnedFacts: number;
  maxQuestions: number;
}

export type PassType = "active" | "structural" | "trivially-empty";

export interface PmbRow {
  caseId: string;
  category: string;
  passType: PassType;
  pass: boolean;
  activePass: boolean;
  precision: number | null;
  recall: number | null;
  relevant: string[];
  failures: string[];
  latencyMs: number;
}

export const DEFAULT_USER_ID = "test-user";
const DEFAULT_BUDGET: Budget = { maxBeliefs: 20, maxPinnedFacts: 10, maxQuestions: 15 };
const EVAL_PERSONA =
  "You prefer direct answers without preamble. You push back when plans have " +
  "problems rather than defaulting to agreement. You edit AI output; you do not " +
  "let AI edit your prose.";

export function budgetOf(c: PmbCase): Budget {
  return { ...DEFAULT_BUDGET, ...c.budget };
}

// Upstream BaseAdapter.beliefToText, canonical_name_aliases mode.
export function beliefToText(b: Belief): string {
  return [b.canonical_name, ...(b.aliases ?? []), b.content, b.why_it_matters].filter(Boolean).join(" ");
}

const inScope = (b: Belief, scope: string[]) => (b.scope ?? []).some((s) => scope.includes(s));

function pinnedFacts(beliefs: Belief[], userId: string, scope: string[]): Belief[] {
  return beliefs.filter(
    (b) =>
      b.user_id === userId &&
      b.pinned === true &&
      b.type !== "open_question" &&
      b.superseded_by == null &&
      b.resolved_at == null &&
      inScope(b, scope),
  );
}

function openQuestions(beliefs: Belief[], userId: string, scope: string[]): Belief[] {
  return beliefs.filter(
    (b) => b.user_id === userId && b.type === "open_question" && b.pinned === true && b.resolved_at == null && inScope(b, scope),
  );
}

// An open-question participant belongs in the openQuestions tier; without
// that filter a perfect provider scores 73/77 instead of upstream's 77/77.
function expandRelations(
  byId: Map<string, Belief>,
  userId: string,
  relationIds: string[],
  scope: string[],
  exclude: Set<string>,
): string[] {
  const out: string[] = [];
  for (const rid of relationIds) {
    const rel = byId.get(rid);
    if (rel?.type !== "relation") continue;
    for (const pid of rel.participants ?? []) {
      const b = byId.get(pid);
      if (exclude.has(pid) || !b || b.user_id !== userId || b.type === "open_question") continue;
      if (scope.length > 0 && !inScope(b, scope)) continue;
      out.push(pid);
    }
  }
  return out;
}

const nonEmpty = (o: object | null | undefined) => o != null && Object.keys(o).length > 0;

function passTypeOf(expect: PmbCase["expect"], expectedRelevant: Set<string>): PassType {
  if (expectedRelevant.size > 0) return "active";
  const other =
    Boolean(expect.relevantBeliefs?.mustExclude?.length) ||
    nonEmpty(expect.openQuestions) ||
    Boolean(expect.pinnedFacts?.mustInclude?.length) ||
    Boolean(expect.pinnedFacts?.mustExclude?.length) ||
    nonEmpty(expect.personaPrelude);
  return other ? "structural" : "trivially-empty";
}

// `searched` is the daemon's ranked belief ids, already distinct.
export function scoreCase(
  c: PmbCase,
  beliefs: Belief[],
  searched: string[],
  latencyMs: number,
): PmbRow {
  const byId = new Map(beliefs.map((b) => [b._id, b]));
  const userId = c.userId ?? DEFAULT_USER_ID;
  const budget = budgetOf(c);
  const cap = budget.maxBeliefs;
  const pinned = pinnedFacts(beliefs, userId, c.scope);
  const pinnedAll = new Set(pinned.map((b) => b._id));
  const searchedHere = c.query.trim() && cap > 0 ? searched : [];

  const raw = searchedHere.filter((id) => !pinnedAll.has(id)).slice(0, cap);
  const expansions =
    raw.length > 0 ? expandRelations(byId, userId, raw, c.scope, new Set([...pinnedAll, ...raw])) : [];
  const cappedPinned = pinned.slice(0, cap);
  const relevant = [...new Set([...raw, ...expansions].slice(0, Math.max(0, cap - cappedPinned.length)))];
  const relevantSet = new Set(relevant);
  const pinnedIds = new Set(cappedPinned.map((b) => b._id));
  const questionIds = new Set(openQuestions(beliefs, userId, c.scope).slice(0, budget.maxQuestions).map((b) => b._id));
  const union = new Set([...pinnedIds, ...relevantSet]);
  const prelude = userId === DEFAULT_USER_ID ? EVAL_PERSONA : "";

  const failures: string[] = [];
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures.push(msg);
  };

  const rb = c.expect.relevantBeliefs ?? {};
  for (const id of rb.mustInclude ?? []) check(union.has(id), `missing expected belief: ${id}`);
  for (const id of rb.mustExclude ?? []) check(!union.has(id), `forbidden belief surfaced: ${id}`);
  for (const id of rb.shouldInclude ?? []) check(union.has(id), `expected belief missing (shouldInclude): ${id}`);
  const only = rb.shouldOnlyInclude;
  if (only != null) {
    const expected = new Set(only);
    for (const id of relevant) check(expected.has(id), `unexpected belief in relevantBeliefs: ${id}`);
    for (const id of expected) check(relevantSet.has(id), `missing expected belief: ${id}`);
  }
  if (rb.maxCount != null) check(relevantSet.size <= rb.maxCount, `relevantBeliefs count ${relevantSet.size} > maxCount ${rb.maxCount}`);
  if (rb.minCount != null) check(relevantSet.size >= rb.minCount, `relevantBeliefs count ${relevantSet.size} < minCount ${rb.minCount}`);
  for (const [a, b] of rb.orderedBefore ?? []) {
    const ia = relevant.indexOf(a);
    const ib = relevant.indexOf(b);
    check(ia !== -1, `orderedBefore: ${a} not in relevantBeliefs`);
    check(ib !== -1, `orderedBefore: ${b} not in relevantBeliefs`);
    if (ia !== -1 && ib !== -1) check(ia < ib, `ranking: ${a} (idx ${ia}) should precede ${b} (idx ${ib})`);
  }

  const pf = c.expect.pinnedFacts ?? {};
  for (const id of pf.mustInclude ?? []) check(pinnedIds.has(id), `missing pinned belief: ${id}`);
  for (const id of pf.mustExclude ?? []) check(!pinnedIds.has(id), `forbidden belief in pinnedFacts: ${id}`);
  const oq = c.expect.openQuestions ?? {};
  for (const id of oq.mustInclude ?? []) check(questionIds.has(id), `missing expected question: ${id}`);
  for (const id of oq.mustExclude ?? []) check(!questionIds.has(id), `forbidden question surfaced: ${id}`);
  const pp = c.expect.personaPrelude ?? {};
  if (pp.nonEmpty) check(prelude.length > 0, "personaPrelude empty");
  if (pp.isNull) check(prelude === "", "personaPrelude not empty");
  for (const s of pp.contains ?? []) check(prelude.includes(s), `personaPrelude missing "${s}"`);
  for (const s of pp.mustNotContain ?? []) check(!prelude.includes(s), `personaPrelude contains "${s}"`);

  const pinnedInSeed = new Set(beliefs.filter((b) => b.pinned === true && b.user_id === DEFAULT_USER_ID).map((b) => b._id));
  const expectedRelevant = new Set(only ?? (rb.mustInclude ?? []).filter((id) => !pinnedInSeed.has(id)));
  const hits = [...expectedRelevant].filter((id) => relevantSet.has(id)).length;
  const precision =
    relevantSet.size === 0 ? (expectedRelevant.size === 0 ? null : 0) : hits / relevantSet.size;
  const recall = expectedRelevant.size > 0 ? hits / expectedRelevant.size : null;
  const passType = passTypeOf(c.expect, expectedRelevant);
  const pass = failures.length === 0;
  return {
    caseId: c.caseId,
    category: c.category,
    passType,
    pass,
    activePass: pass && passType === "active",
    precision,
    recall,
    relevant,
    failures,
    latencyMs,
  };
}

export interface PmbSummary {
  n: number;
  pass: number;
  activePass: number;
  active: number;
  precision: number | null;
  recall: number | null;
}

export function summarizePmb(rows: PmbRow[]): PmbSummary {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    n: rows.length,
    pass: rows.filter((r) => r.pass).length,
    activePass: rows.filter((r) => r.activePass).length,
    active: rows.filter((r) => r.passType === "active").length,
    precision: mean(rows.flatMap((r) => (r.precision === null ? [] : [r.precision]))),
    recall: mean(rows.flatMap((r) => (r.recall === null ? [] : [r.recall]))),
  };
}
