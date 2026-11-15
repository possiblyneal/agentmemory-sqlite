import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDurable, readNdjson, repairNdjson, resumeScores, startNdjson, writeFileAtomic, writeJsonAtomic } from "../eval/runner/durable.js";
import { buildDecisionKey, keyProgressPath, loadOrBuildKey, type Complete, type KeyedSession } from "../eval/runner/decision-key.js";
import { resumeMismatch } from "../eval/runner/suite-resume.js";
import { truncateSavePass } from "../eval/runner/arm-core.js";
import { createJudge, openVerdictCache } from "../eval/runner/decision-judge.js";
import { runCheckpointed, type RunHeader } from "../eval/runner/fold-drift-resume.js";
import { MANIFEST, openSavePass, saveCheckpoint, type Checkpoint } from "../eval/runner/replay-checkpoints.js";
import type { ReplaySession } from "../eval/runner/replay-transcript.js";

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "eval-durable-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const cutLastLine = (path: string, keep: number): void => {
  const text = readFileSync(path, "utf8");
  truncateSync(path, Buffer.byteLength(text) - keep);
};

describe("durable files", () => {
  it("writes whole files through a rename and leaves no partial behind", () => {
    const dir = scratch();
    const path = join(dir, "manifest.json");
    writeFileAtomic(path, "old");
    writeJsonAtomic(path, { a: 1 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1 });
    expect(readdirSync(dir)).toEqual(["manifest.json"]);
  });

  it("drops a torn last line, keeps every finished row and refuses a torn middle", () => {
    const dir = scratch();
    const path = join(dir, "scores.ndjson");
    appendDurable(path, { id: 1 });
    appendDurable(path, { id: 2 });
    appendDurable(path, { id: 3 });
    cutLastLine(path, 6);
    expect(readNdjson<{ id: number }>(path)).toMatchObject({ rows: [{ id: 1 }, { id: 2 }], torn: true });
    writeFileSync(path, '{"id":1}\n{"id":\n{"id":3}\n');
    expect(() => readNdjson(path)).toThrow("line 2 is not JSON");
  });

  it("writes the whole payload, including one past a pipe-sized chunk", () => {
    const dir = scratch();
    const big = "x".repeat(5_000_000);
    writeFileAtomic(join(dir, "big.json"), big);
    expect(readFileSync(join(dir, "big.json"), "utf8")).toBe(big);
    appendDurable(join(dir, "rows.ndjson"), { big });
    expect(readNdjson<{ big: string }>(join(dir, "rows.ndjson")).rows[0].big).toBe(big);
  });

  it("repairs a torn tail so the next append starts a clean line", () => {
    const dir = scratch();
    const path = join(dir, "scores.ndjson");
    writeFileSync(path, '{"id":1}\n{"id":2}\n{"id":3');
    expect(repairNdjson<{ id: number }>(path).map((r) => r.id)).toEqual([1, 2]);
    appendDurable(path, { id: 4 });
    expect(readFileSync(path, "utf8")).toBe('{"id":1}\n{"id":2}\n{"id":4}\n');
  });

  it("gives a complete last line without its newline one", () => {
    const dir = scratch();
    const path = join(dir, "scores.ndjson");
    writeFileSync(path, '{"id":1}\n{"id":2}');
    expect(repairNdjson(path)).toHaveLength(2);
    appendDurable(path, { id: 3 });
    expect(readNdjson(path).rows).toHaveLength(3);
  });

  it("startNdjson resumes past a torn tail and starts empty without --resume", () => {
    const dir = scratch();
    const path = join(dir, "scores.ndjson");
    writeFileSync(path, '{"id":1}\n{"id":2}\n{"i');
    expect(startNdjson<{ id: number }>(path, true).map((r) => r.id)).toEqual([1, 2]);
    expect(startNdjson(path, false)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("");
    expect(startNdjson(join(dir, "missing.ndjson"), true)).toEqual([]);
  });
});

describe("verdict cache", () => {
  it("opens over a torn last line and keeps appending whole rows", async () => {
    const dir = scratch();
    const path = join(dir, "verdicts.ndjson");
    const first = openVerdictCache(path);
    first.set("d1", "text one", true);
    first.set("d2", "text two", false);
    cutLastLine(path, 8);

    const cache = openVerdictCache(path);
    expect(cache.get("d1", "text one")).toBe(true);
    expect(cache.get("d2", "text two")).toBeUndefined();
    let calls = 0;
    const judge = createJudge(async () => (calls++, '{"delivers":true}'), cache);
    expect(await judge.delivers({ id: "d2", text: "x" }, "text two")).toBe(true);
    expect(await judge.delivers({ id: "d1", text: "x" }, "text one")).toBe(true);
    expect(calls).toBe(1);
    expect(openVerdictCache(path).get("d2", "text two")).toBe(true);
    expect(openVerdictCache(path).get("d1", "text one")).toBe(true);
  });

  it("never truncates the shared file and starts its next row on a fresh line", () => {
    const dir = scratch();
    const path = join(dir, "verdicts.ndjson");
    const first = openVerdictCache(path);
    first.set("d1", "text one", true);
    appendFileSync(path, '{"k":"another-process-in-flight');
    const before = readFileSync(path, "utf8");

    const cache = openVerdictCache(path);
    expect(readFileSync(path, "utf8")).toBe(before);
    cache.set("d2", "text two", false);
    expect(readFileSync(path, "utf8").startsWith(before)).toBe(true);
    const reopened = openVerdictCache(path);
    expect(reopened.get("d1", "text one")).toBe(true);
    expect(reopened.get("d2", "text two")).toBe(false);
  });
});

describe("decision key build", () => {
  const session = (id: string, startedAt: string): ReplaySession =>
    ({ id, project: "shop", startedAt, userTurns: [{ turn: 1, text: "add the orders repository please" }] }) as unknown as ReplaySession;
  const entries: KeyedSession[] = [session("s-a", "2026-09-01T10:00:00Z"), session("s-b", "2026-09-02T10:00:00Z")].map((s) => ({
    session: s,
    inputs: [{ kind: "typed", turn: 1, text: "use the query builder" }] as unknown as KeyedSession["inputs"],
  }));
  const llm = (): { complete: Complete; calls: string[] } => {
    const calls: string[] = [];
    const complete: Complete = async (system) => {
      calls.push(system.includes("List the decisions") ? "extract" : "label");
      return system.includes("List the decisions") ? '{"decisions":[{"input":1,"decision":"Use the query builder."}]}' : '{"prompts":[]}';
    };
    return { complete, calls };
  };

  it("resumes past the Sessions a killed build finished, torn tail included", async () => {
    const dir = scratch();
    const progress = join(dir, "key.json.progress.ndjson");
    let extracted = 0;
    const crashing: Complete = async (system) => {
      if (system.includes("List the decisions")) {
        if (extracted === 1) throw new Error("killed");
        extracted++;
        return '{"decisions":[{"input":1,"decision":"Use the query builder."}]}';
      }
      return '{"prompts":[]}';
    };
    await expect(buildDecisionKey(entries, crashing, new Date(), progress)).rejects.toThrow("killed");
    expect(readNdjson(progress).rows).toHaveLength(2);
    appendDurable(progress, { phase: "extract", sessionId: "s-b", decisions: [] });
    cutLastLine(progress, 12);

    const { complete, calls } = llm();
    const key = await buildDecisionKey(entries, complete, new Date(), progress);
    expect(calls.filter((c) => c === "extract")).toHaveLength(1);
    expect(key.decisions).toHaveLength(2);
  });

  it("starts the progress file with a header and discards a file built from other Sessions", async () => {
    const dir = scratch();
    const progress = join(dir, "key.json.progress.ndjson");
    const { complete, calls } = llm();
    await buildDecisionKey(entries, complete, new Date(), progress);
    const [header] = readNdjson<{ header?: string }>(progress).rows;
    expect(typeof header.header).toBe("string");

    const other = llm();
    await buildDecisionKey(entries.slice(0, 1), other.complete, new Date(), progress);
    expect(other.calls.filter((c) => c === "extract")).toHaveLength(1);
    const again = llm();
    await buildDecisionKey(entries.slice(0, 1), again.complete, new Date(), progress);
    expect(again.calls).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("discards a progress file that has no header", async () => {
    const dir = scratch();
    const progress = join(dir, "key.json.progress.ndjson");
    writeFileSync(progress, `${JSON.stringify({ phase: "extract", sessionId: "s-a", decisions: [] })}\n`);
    const { complete, calls } = llm();
    const key = await buildDecisionKey(entries, complete, new Date(), progress);
    expect(calls.filter((c) => c === "extract")).toHaveLength(2);
    expect(key.decisions).toHaveLength(2);
  });

  it("writes the key whole, drops its progress file and rebuilds over a torn key", async () => {
    const dir = scratch();
    const path = join(dir, "key.json");
    writeFileSync(path, '{"version":1,"builtAt":"x","decis');
    const { complete } = llm();
    const built = await loadOrBuildKey(path, false, (progress) => buildDecisionKey(entries, complete, new Date(), progress));
    expect(built.reused).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).decisions).toHaveLength(2);
    expect(existsSync(keyProgressPath(path))).toBe(false);
    expect(readdirSync(dir)).toEqual(["key.json"]);
  });
});

describe("fold-drift checkpoint file", () => {
  const header: RunHeader = {
    store: "a.sqlite",
    batch: 2,
    mode: "full",
    sessions: ["s1", "s2", "s3"],
    decisionKey: null,
    llm: { model: "m" } as unknown as RunHeader["llm"],
  };

  it("cuts only the torn tail on resume and keeps the finished lines byte for byte", async () => {
    const dir = scratch();
    const file = join(dir, "run.ndjson");
    await runCheckpointed({ file, header, resume: false, run: async (sessionId) => ({ sessionId }) });
    const whole = readFileSync(file, "utf8");
    cutLastLine(file, 5);
    const lines = whole.split("\n");
    const kept = `${lines.slice(0, -2).join("\n")}\n`;
    const ran: string[] = [];
    const out = await runCheckpointed({
      file,
      header,
      resume: true,
      run: async (sessionId) => (ran.push(sessionId), { sessionId }),
    });
    expect(ran).toEqual(["s3"]);
    expect(out.results.map((r) => r.sessionId)).toEqual(["s1", "s2", "s3"]);
    expect(readFileSync(file, "utf8").startsWith(kept)).toBe(true);
  });
});

describe("save-pass checkpoints", () => {
  const sessions = ["a", "b", "c"].map(
    (id, i) => ({ id, project: "p", startedAt: `2026-09-0${i + 1}T10:00:00Z` }) as unknown as ReplaySession,
  );
  const scored = new Set(sessions.map((s) => s.id));

  async function savedPass(dir: string): Promise<Checkpoint[]> {
    const source = join(dir, "source.sqlite");
    const db = new DatabaseSync(source);
    db.exec("CREATE TABLE kv (k TEXT, v TEXT); INSERT INTO kv VALUES ('a', '1')");
    db.close();
    const checkpoints = [await saveCheckpoint(source, dir, 1, "b", sessions.slice(0, 1)), await saveCheckpoint(source, dir, 2, "c", sessions.slice(0, 2))];
    writeFileSync(join(dir, MANIFEST), JSON.stringify(checkpoints));
    return checkpoints;
  }

  it("resumes from the last checkpoint when it is sound", async () => {
    const dir = scratch();
    const checkpoints = await savedPass(dir);
    expect(openSavePass(dir, true, sessions, scored).checkpoints).toEqual(checkpoints);
  });

  it("falls back to the previous checkpoint when the last is cut short, and rewrites the manifest", async () => {
    const dir = scratch();
    const checkpoints = await savedPass(dir);
    truncateSync(join(dir, checkpoints[1].file), 100);
    const pass = openSavePass(dir, true, sessions, scored);
    expect(pass.checkpoints).toEqual([checkpoints[0]]);
    expect(pass.resumeAt).toBe(1);
    expect(pass.seed).toBe(join(dir, checkpoints[0].file));
    expect(JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"))).toEqual([checkpoints[0]]);
  });

  it("falls back past a listed checkpoint whose file is gone", async () => {
    const dir = scratch();
    const checkpoints = await savedPass(dir);
    rmSync(join(dir, checkpoints[1].file));
    expect(openSavePass(dir, true, sessions, scored).checkpoints).toEqual([checkpoints[0]]);
  });

  it("refuses when no listed checkpoint is sound", async () => {
    const dir = scratch();
    const checkpoints = await savedPass(dir);
    for (const c of checkpoints) writeFileSync(join(dir, c.file), "garbage");
    expect(() => openSavePass(dir, true, sessions, scored)).toThrow("lists no sound checkpoint");
  });
});

describe("save-pass truncation", () => {
  it("has the kept manifest on disk before any checkpoint file is removed", () => {
    const dir = scratch();
    const cp = (i: number) => ({ sessionId: `id${i}`, file: `${String(i).padStart(3, "0")}-id${i}.sqlite`, ingested: [] as string[] });
    const manifest = [cp(1), cp(2), cp(3)];
    for (const c of manifest) writeFileSync(join(dir, c.file), "db");
    writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest));
    writeFileSync(join(dir, "run.json"), "{}");

    expect(() =>
      truncateSavePass(dir, 1, () => {
        throw new Error("killed");
      }),
    ).toThrow("killed");
    expect(JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"))).toEqual([cp(1)]);
    expect(existsSync(join(dir, cp(3).file))).toBe(true);

    truncateSavePass(dir, 1);
    expect(existsSync(join(dir, "run.json"))).toBe(false);
    expect(existsSync(join(dir, cp(1).file))).toBe(true);
  });
});

describe("resumeScores", () => {
  type Row = { adapter: string; questionId: string; k: number };
  const key = (r: Row) => `${r.adapter}:${r.questionId}`;
  const row = (questionId: string, k: number): Row => ({ adapter: "a", questionId, k });

  it("counts a question finished only when its rows cover every k, and rewrites the file without the rest", () => {
    const dir = scratch();
    const path = join(dir, "scores.ndjson");
    for (const r of [row("q1", 5), row("q1", 10), row("q2", 5), row("q3", 5), row("q3", 5)]) appendDurable(path, r);
    const { rows, finished } = resumeScores<Row>(path, true, [5, 10], key);
    expect([...finished]).toEqual(["a:q1"]);
    expect(rows).toEqual([row("q1", 5), row("q1", 10)]);
    expect(readNdjson<Row>(path).rows).toEqual(rows);
  });

  it("refuses a file with a row at a k this run does not score", () => {
    const dir = scratch();
    const path = join(dir, "scores.ndjson");
    appendDurable(path, row("q1", 7));
    expect(() => resumeScores<Row>(path, true, [5, 10], key)).toThrow("another --k");
  });

  it("starts empty without --resume", () => {
    const dir = scratch();
    const path = join(dir, "scores.ndjson");
    appendDurable(path, row("q1", 5));
    expect(resumeScores<Row>(path, false, [5], key).finished.size).toBe(0);
  });
});

describe("suite --resume identity", () => {
  const current = { commit: "abc1234", dirty: false, config: { EMBEDDING_PROVIDER: "local" } };

  it("accepts the same run and a dir with no meta.json", () => {
    const dir = scratch();
    expect(resumeMismatch(dir, current)).toEqual([]);
    writeJsonAtomic(join(dir, "meta.json"), current);
    expect(resumeMismatch(dir, current)).toEqual([]);
  });

  it("names a changed commit, tree state and config key", () => {
    const dir = scratch();
    writeJsonAtomic(join(dir, "meta.json"), current);
    const diffs = resumeMismatch(dir, { commit: "def5678", dirty: true, config: { AGENTMEMORY_PROMPT_RERANK: "off" } });
    expect(diffs).toHaveLength(4);
    expect(diffs.join("\n")).toContain("commit: earlier run abc1234, this run def5678");
    expect(diffs.join("\n")).toContain("EMBEDDING_PROVIDER: earlier run local, this run unset");
  });
});
