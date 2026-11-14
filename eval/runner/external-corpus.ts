import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ExternalCorpus, ExternalItem } from "./external-text.js";

// Builds the corpus `eval:replay --external-corpus` ingests: each repository's
// commits (git log) and pull request and issue text (gh), read-only. It holds
// private repository text, so keep the output under tmp/.

const MAX_TEXT_CHARS = 4000;

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

function projectOf(repo: string): string {
  const common = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], repo).trim();
  return basename(common) === ".git" ? basename(dirname(common)) : basename(repo);
}

const FIELD = "\u001f";
const RECORD = "\u001e";

function commits(repo: string, project: string): ExternalItem[] {
  const out = run(
    "git",
    ["log", "--branches", "--remotes=origin", "--no-merges", "--name-only", `--format=${RECORD}%H${FIELD}%cI${FIELD}%B${FIELD}`],
    repo,
  );
  return out
    .split(RECORD)
    .filter(Boolean)
    .map((record) => {
      const [sha, at, message, names] = record.split(FIELD);
      const files = names.split("\n").map((f) => f.trim()).filter(Boolean);
      const text = `${message.trim()}\n\nFiles: ${files.join(", ")}`.slice(0, MAX_TEXT_CHARS);
      return { source: "commits" as const, project, id: sha, at, text, files };
    });
}

interface GhRow {
  number: number;
  title: string;
  body: string;
  closedAt: string | null;
  updatedAt: string;
}

function githubRepo(repo: string): string {
  const url = run("git", ["remote", "get-url", "origin"], repo).trim();
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!match) throw new Error(`${repo}: origin ${url} is not a GitHub remote`);
  return match[1];
}

function ghItems(repo: string, project: string, kind: "pr" | "issue"): ExternalItem[] {
  const rows = JSON.parse(
    run(
      "gh",
      [kind, "list", "--repo", githubRepo(repo), "--state", "all", "--limit", "5000", "--json", "number,title,body,closedAt,updatedAt"],
      repo,
    ),
  ) as GhRow[];
  return rows.map((r) => ({
    source: kind === "pr" ? ("prs" as const) : ("issues" as const),
    project,
    id: `${kind}-${r.number}`,
    at: r.closedAt ?? r.updatedAt,
    text: `${r.title}\n\n${r.body ?? ""}`.trim().slice(0, MAX_TEXT_CHARS),
    files: [],
  }));
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: { out: { type: "string" } },
    allowPositionals: true,
  });
  if (!values.out || positionals.length === 0) {
    console.error("usage: eval:external-corpus --out <file.json> <repo checkout>...");
    process.exit(2);
  }
  const items: ExternalItem[] = [];
  for (const repo of positionals.map((p) => resolve(p))) {
    const project = projectOf(repo);
    const found = [...commits(repo, project), ...ghItems(repo, project, "pr"), ...ghItems(repo, project, "issue")];
    console.log(`${project}: ${found.filter((i) => i.source === "commits").length} commits, ${found.filter((i) => i.source === "prs").length} PRs, ${found.filter((i) => i.source === "issues").length} issues`);
    items.push(...found);
  }
  const corpus: ExternalCorpus = { builtAt: new Date().toISOString(), items };
  mkdirSync(dirname(resolve(values.out)), { recursive: true });
  writeFileSync(values.out, JSON.stringify(corpus));
  console.log(`wrote ${items.length} items to ${values.out}`);
}

main();
