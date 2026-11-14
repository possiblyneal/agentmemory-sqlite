import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDurable, readNdjson, repairNdjson, startNdjson, writeFileAtomic, writeJsonAtomic } from "../eval/runner/durable.js";
import { buildDecisionKey, keyProgressPath, loadOrBuildKey, type Complete, type KeyedSession } from "../eval/runner/decision-key.js";
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
    expect(readNdjson<{ id: number }>(path)).toEqual({ rows: [{ id: 1 }, { id: 2 }], torn: true });
    writeFileSync(path, '{"id":1}\n{"id":\n{"id":3}\n');
    expect(() => readNdjson(path)).toThrow("line 2 is not JSON");
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
    expect(readNdjson(path).torn).toBe(false);
    expect(readNdjson(path).rows).toHaveLength(2);
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
    expect(readNdjson(progress).rows).toHaveLength(1);
    appendDurable(progress, { phase: "extract", sessionId: "s-b", decisions: [] });
    cutLastLine(progress, 12);

    const { complete, calls } = llm();
    const key = await buildDecisionKey(entries, complete, new Date(), progress);
    expect(calls.filter((c) => c === "extract")).toHaveLength(1);
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
