import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function projectNamesPath(): string {
  return join(homedir(), ".agentmemory", "project-names.json");
}

function remoteUrl(dir: string): string {
  try {
    return execSync("git config --get remote.origin.url", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    })
      .toString()
      .trim()
      .replace(/\.git$/, "");
  } catch {
    return "";
  }
}

// The first checkout to claim a basename keeps it bare; a different repo with the
// same basename gets a suffix from its identity (remote URL, else the common-dir path).
function disambiguate(name: string, commonDir: string, dir: string): string {
  const identity = remoteUrl(dir) || commonDir;
  try {
    const path = projectNamesPath();
    let claims: Record<string, string> = {};
    try {
      claims = JSON.parse(readFileSync(path, "utf-8"));
    } catch {}
    if (!(name in claims)) {
      mkdirSync(dirname(path), { recursive: true });
      const staged = `${path}.${process.pid}`;
      writeFileSync(staged, JSON.stringify({ ...claims, [name]: identity }));
      renameSync(staged, path);
      return name;
    }
    if (claims[name] === identity) return name;
    return `${name}-${createHash("sha1").update(identity).digest("hex").slice(0, 6)}`;
  } catch {
    return name;
  }
}

// Resolution order: AGENTMEMORY_PROJECT_NAME env → main checkout basename (so every
// worktree of a repo shares one project; same-named repos are told apart by
// disambiguate) → toplevel basename → cwd basename.
export function resolveProject(cwd?: string): string {
  const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
  if (explicit && explicit.trim()) return explicit.trim();
  const dir = cwd && cwd.trim() ? cwd : process.cwd();
  try {
    const [commonDir, top] = execSync("git rev-parse --git-common-dir --show-toplevel", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    })
      .toString()
      .trim()
      .split("\n");
    if (commonDir && basename(commonDir) === ".git") {
      const root = dirname(resolve(dir, commonDir));
      return disambiguate(basename(root), resolve(dir, commonDir), dir);
    }
    if (top) return disambiguate(basename(top), resolve(dir, commonDir || top), dir);
  } catch {}
  return basename(dir);
}

export function hookCwd(data: Record<string, unknown> | null | undefined): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
  const projectDir = process.env["CLAUDE_PROJECT_DIR"];
  if (projectDir && projectDir.trim()) return projectDir;
  return undefined;
}
