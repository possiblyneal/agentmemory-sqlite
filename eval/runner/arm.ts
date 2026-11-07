import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { failedSessionIndex, parseArmArgs, probeArgs, resumePlan } from "./arm-core.js";
import { MANIFEST, type Checkpoint } from "./replay-checkpoints.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_SAVE_ATTEMPTS = 40;
const MAX_PROBE_ATTEMPTS = 6;
const KEY_FILES = ["decision-key.json", "decision-verdicts.ndjson"];

function run(cwd: string, cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

// With `watch`, the pass is killed at the first Session whose summarize failed.
function replayPass(tree: string, args: string[], log: string, watch: boolean): Promise<{ code: number | null; failedIndex?: number }> {
  return new Promise((done) => {
    const child = spawn("npm", ["run", "eval:replay", "--", ...args], { cwd: tree, detached: true });
    const stop = () => {
      process.kill(-child.pid!, "SIGTERM");
      process.exit(130);
    };
    process.once("SIGINT", stop).once("SIGTERM", stop);
    const out = createWriteStream(log, { flags: "a" });
    let failedIndex: number | undefined;
    child.stderr.pipe(out, { end: false });
    createInterface({ input: child.stdout }).on("line", (line) => {
      console.log(line);
      out.write(`${line}\n`);
      const idx = watch && failedIndex === undefined ? failedSessionIndex(line) : undefined;
      if (idx !== undefined) {
        failedIndex = idx;
        process.kill(-child.pid!, "SIGTERM");
        setTimeout(() => process.kill(-child.pid!, "SIGKILL"), 10_000).unref();
      }
    });
    child.on("close", (code) => {
      process.off("SIGINT", stop).off("SIGTERM", stop);
      out.end();
      done({ code, failedIndex });
    });
  });
}

function truncateSavePass(checkpointDir: string, failedIndex: number) {
  const manifestPath = join(checkpointDir, MANIFEST);
  const { keep, remove } = resumePlan(JSON.parse(readFileSync(manifestPath, "utf8")) as Checkpoint[], failedIndex);
  for (const file of remove) rmSync(join(checkpointDir, file), { force: true });
  if (keep.length > 0) writeFileSync(manifestPath, JSON.stringify(keep, null, 2));
  else rmSync(manifestPath);
  console.log(`failed summarize in Session ${failedIndex + 1}: ${keep.length > 0 ? `resuming from ${keep.at(-1)!.file}` : "no clean checkpoint left, restarting"}`);
}

async function main() {
  const { ref, label, replayArgs } = parseArmArgs(process.argv.slice(2));
  const armDir = join(REPO_ROOT, "tmp", "eval-arms", label);
  const tree = join(armDir, "tree");
  const save = join(armDir, "out", "save");
  const probe = join(armDir, "out", "probe");
  if (existsSync(armDir)) throw new Error(`${armDir} exists; pick a fresh --label or remove it`);
  mkdirSync(join(armDir, "out"), { recursive: true });

  run(REPO_ROOT, "git", ["worktree", "add", "-b", `eval-arm/${label}`, tree, ref]);
  run(REPO_ROOT, "git", ["worktree", "lock", "--reason", `eval:arm ${label}`, tree]);
  run(tree, "npm", ["ci"]);
  run(tree, "npm", ["run", "build"]);

  // The runner only accepts --out under its own tmp/; link that to the arm's out/.
  mkdirSync(join(tree, "tmp", "eval-replay"), { recursive: true });
  symlinkSync(join(armDir, "out"), join(tree, "tmp", "arm-out"));
  for (const file of KEY_FILES) {
    const from = join(REPO_ROOT, "tmp", "eval-replay", file);
    if (existsSync(from)) copyFileSync(from, join(tree, "tmp", "eval-replay", file));
  }
  const treeOut = (name: string) => join(tree, "tmp", "arm-out", name);

  const checkpointDir = join(save, "checkpoints");
  let saved = false;
  for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS && !saved; attempt++) {
    const resume = existsSync(join(checkpointDir, MANIFEST)) ? ["--resume"] : [];
    console.log(`save pass attempt ${attempt} ${resume.join(" ")}`);
    const { code, failedIndex } = await replayPass(tree, [...replayArgs, "--decision-key", "--save-checkpoints", ...resume, "--out", treeOut("save")], join(armDir, "save.log"), true);
    if (failedIndex !== undefined) truncateSavePass(checkpointDir, failedIndex);
    saved = code === 0 && existsSync(join(checkpointDir, "run.json"));
  }
  if (!saved) throw new Error(`save pass did not finish in ${MAX_SAVE_ATTEMPTS} attempts; see ${join(armDir, "save.log")}`);

  for (let attempt = 1; attempt <= MAX_PROBE_ATTEMPTS; attempt++) {
    console.log(`probe pass attempt ${attempt}`);
    const { code } = await replayPass(tree, [...probeArgs(replayArgs), "--from-checkpoints", join(tree, "tmp", "arm-out", "save", "checkpoints"), "--decision-key", "--out", treeOut("probe")], join(armDir, "probe.log"), false);
    if (code === 0) {
      console.log(`arm ${label} done: ${probe}`);
      return;
    }
  }
  throw new Error(`probe pass failed ${MAX_PROBE_ATTEMPTS} times; see ${join(armDir, "probe.log")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
