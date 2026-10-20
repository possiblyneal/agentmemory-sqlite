import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerContextFunction } from "../src/functions/context.js";
import { registerLessonsFunctions, resetLessonIndex } from "../src/functions/lessons.js";
import { registerPromptContextFunction } from "../src/functions/prompt-context.js";
import { registerReflectFunctions } from "../src/functions/reflect.js";
import { registerRelationsFunction } from "../src/functions/relations.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { getSearchIndex, registerSearchFunction } from "../src/functions/search.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { memoryToIndexDoc } from "../src/state/memory-utils.js";
import { KV } from "../src/state/schema.js";
import type {
  CompactSearchResult,
  CompressedObservation,
  Insight,
  Lesson,
  Memory,
  SemanticMemory,
  Session,
  SessionSummary,
} from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const PROJECT = "project-p";
const OLD = "2026-09-01T10:00:00.000Z";
const NEW = "2026-10-10T10:00:00.000Z";
const AFTER_OLD = "2026-09-01T11:00:00.000Z";
const AFTER_NEW = "2026-10-10T11:00:00.000Z";

const STALE = "indent with tabs";
const FRESH = "indent with spaces";

interface SmartSearchResponse {
  results: CompactSearchResult[];
  lessons: Array<{ content: string }>;
  insights: Array<{ insightId: string }>;
  semanticFacts: Array<{ fact: string }>;
}

let kv: ReturnType<typeof mockKV>;
let sdk: ReturnType<typeof mockSdk>;

function indexOf(text: string, needle: string): number {
  return text.indexOf(needle);
}

function ranksBefore(text: string, first: string, second: string): boolean {
  const a = indexOf(text, first);
  const b = indexOf(text, second);
  return a !== -1 && b !== -1 && a < b;
}

function session(id: string, startedAt: string): Session {
  return {
    id,
    project: PROJECT,
    cwd: `/work/${PROJECT}`,
    startedAt,
    status: "completed",
    observationCount: 1,
  };
}

function observation(id: string, sessionId: string, timestamp: string, narrative: string, importance = 6): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp,
    type: "decision",
    title: narrative.slice(0, 40),
    facts: [],
    narrative,
    concepts: [],
    files: [],
    importance,
  };
}

async function seedObservation(obs: CompressedObservation): Promise<void> {
  await kv.set(KV.observations(obs.sessionId), obs.id, obs);
  getSearchIndex().add(obs);
}

async function seedFillerSessions(count: number): Promise<void> {
  await kv.set(KV.sessions, "ses_filler", { ...session("ses_filler", OLD), project: "project-other" });
  for (let i = 0; i < count; i++) {
    await seedObservation(
      observation(`obs_filler_${i}`, "ses_filler", OLD, `unrelated note ${i} about database migration batch${i} and cache warmup${i}`),
    );
  }
}

function summary(sessionId: string, fields: Partial<SessionSummary> & { keyDecisions: string[] }): SessionSummary {
  return {
    sessionId,
    project: PROJECT,
    createdAt: OLD,
    title: `Work ${sessionId}`,
    narrative: "n",
    filesModified: [],
    concepts: [],
    observationCount: 1,
    ...fields,
  };
}

function memory(id: string, content: string, createdAt: string, extra: Partial<Memory> = {}): Memory {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    type: "preference",
    title: content.slice(0, 80),
    content,
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 7,
    version: 1,
    supersedes: [],
    sourceObservationIds: [],
    isLatest: true,
    project: PROJECT,
    ...extra,
  };
}

function semanticFact(id: string, fact: string, confidence: number, createdAt: string): SemanticMemory {
  return {
    id,
    fact,
    confidence,
    sourceSessionIds: ["ses_a"],
    sourceMemoryIds: [],
    accessCount: 1,
    lastAccessedAt: createdAt,
    strength: confidence,
    createdAt,
    updatedAt: createdAt,
  };
}

function insight(id: string, title: string, content: string, confidence: number, createdAt: string): Insight {
  return {
    id,
    title,
    content,
    confidence,
    reinforcements: 0,
    sourceConceptCluster: [],
    sourceMemoryIds: [],
    sourceLessonIds: [],
    sourceCrystalIds: [],
    project: PROJECT,
    tags: [],
    createdAt,
    updatedAt: createdAt,
    decayRate: 0.05,
  };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
  kv = mockKV();
  sdk = mockSdk({ looseTrigger: true });
  getSearchIndex().clear();
  resetLessonIndex();
  await kv.set(KV.sessions, "ses_a", session("ses_a", OLD));
  await kv.set(KV.sessions, "ses_b", session("ses_b", NEW));
  await kv.set(KV.sessions, "ses_now", session("ses_now", "2026-10-20T09:00:00.000Z"));
  registerRememberFunction(sdk as never, kv as never);
  registerRelationsFunction(sdk as never, kv as never);
  registerSearchFunction(sdk as never, kv as never);
  registerLessonsFunctions(sdk as never, kv as never);
  registerReflectFunctions(sdk as never, kv as never, {} as never);
  registerContextFunction(sdk as never, kv as never, 8000);
  registerPromptContextFunction(sdk as never, kv as never);
  const hybrid = new HybridSearch(getSearchIndex(), null, null, kv as never, 1, 0, 0);
  registerSmartSearchFunction(sdk as never, kv as never, (query, limit) => hybrid.search(query, limit));
  await seedFillerSessions(40);
});

afterEach(() => vi.useRealTimers());

const smartSearch = (query: string) =>
  sdk.trigger("mem::smart-search", { query, project: PROJECT }) as Promise<SmartSearchResponse>;

const sessionStart = async () =>
  ((await sdk.trigger("mem::context", { sessionId: "ses_now", project: PROJECT })) as { context: string }).context;

const promptSubmit = async (prompt: string) =>
  ((await sdk.trigger("mem::prompt-context", { sessionId: "ses_now", project: PROJECT, prompt })) as { context: string }).context;

async function saveMemory(content: string) {
  return (await sdk.trigger("mem::remember", { content, project: PROJECT, type: "preference" })) as { success: boolean; memory: Memory };
}

const NEAR_RESTATEMENT_A = "Always indent source files with tabs in this repository, never spaces";
const NEAR_RESTATEMENT_B = "Always indent source files with spaces in this repository, never tabs";
const LOW_OVERLAP_A = "Formatting convention for the repository: tabs are used for indentation";
const LOW_OVERLAP_B = "Decision: two-space indentation is now mandatory throughout, tabs banned";

describe("supersession: Memory", () => {
  it("smart-search hides a Memory that a near-restatement saved later superseded", async () => {
    await saveMemory(NEAR_RESTATEMENT_A);
    await saveMemory(NEAR_RESTATEMENT_B);
    const { results } = await smartSearch("indent tabs spaces repository");
    expect(results.map((r) => r.title)).toEqual([NEAR_RESTATEMENT_B]);
  });

  it("prompt-submit hides a Memory that a near-restatement saved later superseded", async () => {
    await saveMemory(NEAR_RESTATEMENT_A);
    await saveMemory(NEAR_RESTATEMENT_B);
    const context = await promptSubmit("should we indent source files with tabs or spaces in this repository");
    expect(context).toContain(NEAR_RESTATEMENT_B);
    expect(context).not.toContain(NEAR_RESTATEMENT_A);
  });

  it.fails("smart-search ranks a contradicting Memory with little wording in common above the stale one", async () => {
    await saveMemory(LOW_OVERLAP_A);
    await saveMemory(LOW_OVERLAP_B);
    const { results } = await smartSearch("indentation tabs");
    expect(results.map((r) => r.title)).toEqual([LOW_OVERLAP_B]);
  });

  it.fails("prompt-submit gives a contradicting Memory with little wording in common and not the stale one", async () => {
    await saveMemory(LOW_OVERLAP_A);
    await saveMemory(LOW_OVERLAP_B);
    const context = await promptSubmit("what is the indentation convention, are tabs used for indentation here");
    expect(context).toContain(LOW_OVERLAP_B);
    expect(context).not.toContain(LOW_OVERLAP_A);
  });

  it("smart-search hides a Memory that mem::evolve replaced", async () => {
    const stale = memory("mem_stale", NEAR_RESTATEMENT_A, OLD);
    await kv.set(KV.memories, stale.id, stale);
    getSearchIndex().add(memoryToIndexDoc(stale), "memory");
    await sdk.trigger("mem::evolve", {
      memoryId: stale.id,
      newContent: NEAR_RESTATEMENT_B,
      newTitle: NEAR_RESTATEMENT_B,
    });
    const { results } = await smartSearch("indent tabs spaces repository");
    expect(results.map((r) => r.title)).toEqual([NEAR_RESTATEMENT_B]);
  });

  it("prompt-submit hides a Memory that mem::evolve replaced", async () => {
    const stale = memory("mem_stale", NEAR_RESTATEMENT_A, OLD);
    await kv.set(KV.memories, stale.id, stale);
    getSearchIndex().add(memoryToIndexDoc(stale), "memory");
    await sdk.trigger("mem::evolve", {
      memoryId: stale.id,
      newContent: NEAR_RESTATEMENT_B,
      newTitle: NEAR_RESTATEMENT_B,
    });
    const context = await promptSubmit("should we indent source files with tabs or spaces in this repository");
    expect(context).toContain(NEAR_RESTATEMENT_B);
    expect(context).not.toContain(NEAR_RESTATEMENT_A);
  });

  it("session start does not reach Memories, so a superseded one cannot appear", async () => {
    await saveMemory(NEAR_RESTATEMENT_A);
    await saveMemory(NEAR_RESTATEMENT_B);
    const context = await sessionStart();
    expect(context).not.toContain(NEAR_RESTATEMENT_A);
    expect(context).not.toContain(NEAR_RESTATEMENT_B);
  });
});

describe("supersession: Semantic Fact", () => {
  beforeEach(async () => {
    await kv.set(KV.semantic, "sem_stale", semanticFact("sem_stale", `The team agreed to ${STALE}`, 0.8, OLD));
    await kv.set(KV.semantic, "sem_fresh", semanticFact("sem_fresh", `The team agreed to ${FRESH}`, 0.7, NEW));
  });

  it.fails("smart-search returns the newer Semantic Fact ahead of the contradicted one", async () => {
    const { semanticFacts } = await smartSearch("agreed indent tabs spaces");
    expect(semanticFacts[0].fact).toContain(FRESH);
  });

  it.fails("session start lists the newer Semantic Fact ahead of the contradicted one", async () => {
    expect(ranksBefore(await sessionStart(), FRESH, STALE)).toBe(true);
  });
});

describe("supersession: prompt-submit does not reach Semantic Facts, Lessons or Insights", () => {
  it("prompt-submit gives none of them, so a contradicted one cannot appear", async () => {
    await kv.set(KV.semantic, "sem_stale", semanticFact("sem_stale", `The team agreed to ${STALE}`, 0.8, OLD));
    await sdk.trigger("mem::lesson-save", { content: `Rule: ${STALE}`, project: PROJECT });
    await kv.set(KV.insights, "ins_stale", insight("ins_stale", "Whitespace style", `Team will ${STALE}`, 0.8, OLD));
    const context = await promptSubmit("what is the whitespace rule, should we indent with tabs or spaces everywhere in the repository");
    expect(context).toBe("");
  });
});

describe("supersession: Lesson", () => {
  beforeEach(async () => {
    vi.setSystemTime(new Date(OLD));
    await sdk.trigger("mem::lesson-save", { content: `Rule: ${STALE}`, project: PROJECT });
    await sdk.trigger("mem::lesson-save", { content: `Rule: ${STALE}`, project: PROJECT });
    await sdk.trigger("mem::lesson-save", { content: `Rule: ${STALE}`, project: PROJECT });
    vi.setSystemTime(new Date(NEW));
    await sdk.trigger("mem::lesson-save", { content: `Rule: ${FRESH}`, project: PROJECT });
    vi.setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
  });

  it("smart-search returns the newer Lesson ahead of the contradicted one", async () => {
    const { lessons } = await smartSearch("rule indent tabs spaces");
    expect(lessons[0].content).toContain(FRESH);
  });

  it("session start lists the newer Lesson ahead of the contradicted one", async () => {
    for (const lesson of await kv.list<Lesson>(KV.lessons)) {
      const stamp = lesson.content.includes(STALE) ? OLD : NEW;
      await kv.set(KV.lessons, lesson.id, { ...lesson, createdAt: stamp, updatedAt: stamp, lastReinforcedAt: lesson.reinforcements ? stamp : undefined });
    }
    expect(ranksBefore(await sessionStart(), FRESH, STALE)).toBe(true);
  });
});

describe("supersession: Insight", () => {
  beforeEach(async () => {
    await kv.set(KV.insights, "ins_stale", insight("ins_stale", "Whitespace style", `Team will ${STALE}`, 0.8, OLD));
    await kv.set(KV.insights, "ins_fresh", insight("ins_fresh", "Whitespace style", `Team will ${FRESH}`, 0.5, NEW));
  });

  it("smart-search returns the newer Insight ahead of the contradicted one", async () => {
    const { insights } = await smartSearch("whitespace style indent tabs spaces");
    expect(insights[0].insightId).toBe("ins_fresh");
  });

  it("session start lists the newer Insight ahead of the contradicted one", async () => {
    expect(ranksBefore(await sessionStart(), FRESH, STALE)).toBe(true);
  });
});

describe("supersession: Session Summary decision", () => {
  async function seedSessions(old: { createdAt: string; lastObservationAt: string }, fresh: { createdAt: string; lastObservationAt: string }) {
    await seedObservation(observation("obs_a", "ses_a", old.lastObservationAt, `Settled the whitespace rule: ${STALE} everywhere in the repository`));
    await seedObservation(observation("obs_b", "ses_b", fresh.lastObservationAt, `Reversed the whitespace rule: ${FRESH} everywhere in the repository`));
    await kv.set(KV.summaries, "ses_a", summary("ses_a", { ...old, keyDecisions: [`Rule: ${STALE}`], coveredThrough: old.createdAt }));
    await kv.set(KV.summaries, "ses_b", summary("ses_b", { ...fresh, keyDecisions: [`Rule: ${FRESH}`], coveredThrough: fresh.createdAt }));
  }

  it("smart-search never returns a Session Summary decision on its own", async () => {
    await seedSessions({ createdAt: AFTER_OLD, lastObservationAt: OLD }, { createdAt: AFTER_NEW, lastObservationAt: NEW });
    const { results } = await smartSearch("rule indent tabs spaces");
    expect(results.map((r) => r.sessionId).sort()).toEqual(["ses_a", "ses_b"]);
    expect(JSON.stringify(results)).not.toContain("Rule: indent");
  });

  it("prompt-submit gives the newer Session's decisions ahead of the older one's", async () => {
    await seedSessions({ createdAt: AFTER_OLD, lastObservationAt: OLD }, { createdAt: AFTER_NEW, lastObservationAt: NEW });
    const context = await promptSubmit("what is the whitespace rule, should we indent with tabs or spaces everywhere in the repository");
    expect(ranksBefore(context, `Rule: ${FRESH}`, `Rule: ${STALE}`)).toBe(true);
  });

  it.fails("prompt-submit puts a Memory that contradicts a Session decision ahead of that decision", async () => {
    await seedObservation(observation("obs_a", "ses_a", OLD, `Settled the whitespace rule: ${STALE} everywhere in the repository`));
    await kv.set(KV.summaries, "ses_a", summary("ses_a", { keyDecisions: [`Rule: ${STALE}`], createdAt: AFTER_OLD, coveredThrough: AFTER_OLD, lastObservationAt: OLD }));
    await saveMemory(`Whitespace rule reversed, ${FRESH} everywhere in the repository`);
    const context = await promptSubmit("what is the whitespace rule, should we indent with tabs or spaces everywhere in the repository");
    expect(ranksBefore(context, FRESH, `Rule: ${STALE}`)).toBe(true);
  });

  it("session start lists the Session whose work is newer first when summaries were written in work order", async () => {
    await seedSessions({ createdAt: AFTER_OLD, lastObservationAt: OLD }, { createdAt: AFTER_NEW, lastObservationAt: NEW });
    expect(ranksBefore(await sessionStart(), `Rule: ${FRESH}`, `Rule: ${STALE}`)).toBe(true);
  });

  it.fails("session start lists the Session whose work is newer first when its summary was written earlier", async () => {
    await seedSessions(
      { createdAt: "2026-10-15T00:00:00.000Z", lastObservationAt: OLD },
      { createdAt: "2026-10-11T00:00:00.000Z", lastObservationAt: NEW },
    );
    expect(ranksBefore(await sessionStart(), `Rule: ${FRESH}`, `Rule: ${STALE}`)).toBe(true);
  });
});

describe("supersession: Observation", () => {
  beforeEach(async () => {
    await seedObservation({ ...observation("obs_a", "ses_a", OLD, `Whitespace rule: we ${STALE} in every source file of the repository`), title: "Whitespace rule" });
    await seedObservation({ ...observation("obs_b", "ses_b", NEW, `Whitespace rule: we ${FRESH} in every source file of the repository`), title: "Whitespace rule" });
  });

  it("smart-search ranks the newer Observation above the contradicted one", async () => {
    const { results } = await smartSearch("whitespace rule indent tabs spaces source file");
    expect(results[0].obsId).toBe("obs_b");
  });

  it("smart-search ranks the newer Observation above a contradicted one that matches the query more strongly", async () => {
    await seedObservation(
      observation("obs_a2", "ses_a", OLD, `Whitespace rule whitespace rule: we ${STALE}, ${STALE}, never spaces, tabs tabs tabs in every source file`),
    );
    const { results } = await smartSearch("whitespace rule indent tabs spaces source file");
    expect(results[0].obsId).toBe("obs_b");
  });

  it.fails("prompt-submit gives the newer Observation ahead of a contradicted one that matches the prompt more strongly", async () => {
    await seedObservation(
      observation("obs_a2", "ses_a", OLD, `Whitespace rule whitespace rule: we ${STALE}, ${STALE}, never spaces, tabs tabs tabs in every source file of the repository`),
    );
    const context = await promptSubmit("what is the whitespace rule, should we indent with tabs or spaces in every source file of the repository");
    expect(ranksBefore(context, FRESH, STALE)).toBe(true);
  });

  it("session start lists the newer Session's Observation ahead of the contradicted one", async () => {
    expect(ranksBefore(await sessionStart(), FRESH, STALE)).toBe(true);
  });

  it.fails("prompt-submit gives the newer Observation ahead of the contradicted one", async () => {
    const context = await promptSubmit("what is the whitespace rule, should we indent with tabs or spaces in every source file of the repository");
    expect(ranksBefore(context, FRESH, STALE)).toBe(true);
  });
});
