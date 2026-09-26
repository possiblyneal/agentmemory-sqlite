import { execSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

// Resolution order: AGENTMEMORY_PROJECT_NAME env → main checkout basename (so every
// git worktree of a repo shares one project) → git toplevel basename → cwd basename.
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
      return basename(dirname(resolve(dir, commonDir)));
    }
    if (top) return basename(top);
  } catch {}
  return basename(dir);
}

export function hookCwd(data: Record<string, unknown> | null | undefined): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
  const roots = data.workspace_roots;
  if (Array.isArray(roots)) {
    for (const root of roots) {
      if (typeof root === "string" && root.trim()) return root;
    }
  }
  const projectDir =
    process.env["DEVIN_PROJECT_DIR"] || process.env["CLAUDE_PROJECT_DIR"];
  if (projectDir && projectDir.trim()) return projectDir;
  return undefined;
}
