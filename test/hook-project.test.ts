import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveProject } from "../src/hooks/_project.js";

// The checkout directory is not necessarily named "agentmemory" — contributors clone
// into forks, worktrees and arbitrary paths — so the git-toplevel assertions run against
// a throwaway repo whose name we control instead of against process.cwd().
const REPO_NAME = "amem-fixture-repo";

describe("resolveProject — hook project basename resolver", () => {
  const originalEnv = process.env.AGENTMEMORY_PROJECT_NAME;

  let tmpRoot: string;
  let repoDir: string;
  let nestedDir: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "amem-project-"));
    repoDir = join(tmpRoot, REPO_NAME);
    nestedDir = join(repoDir, "src", "hooks");
    mkdirSync(nestedDir, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: repoDir, stdio: "ignore" });
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const originalHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    delete process.env.AGENTMEMORY_PROJECT_NAME;
    home = mkdtempSync(join(tmpdir(), "amem-home-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.AGENTMEMORY_PROJECT_NAME;
    } else {
      process.env.AGENTMEMORY_PROJECT_NAME = originalEnv;
    }
  });

  it("AGENTMEMORY_PROJECT_NAME env wins over everything", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "my-override";
    expect(resolveProject("/var/log")).toBe("my-override");
    expect(resolveProject(repoDir)).toBe("my-override");
  });

  it("trims whitespace on env override", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "  spaced  ";
    expect(resolveProject("/var/log")).toBe("spaced");
  });

  it("ignores empty env override", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "   ";
    expect(resolveProject(repoDir)).toBe(REPO_NAME);
  });

  it("returns git toplevel basename when cwd is inside a repo", () => {
    expect(resolveProject(repoDir)).toBe(REPO_NAME);
  });

  it("returns git toplevel basename from a nested subdir", () => {
    expect(resolveProject(nestedDir)).toBe(REPO_NAME);
  });

  it("names a linked worktree after its main checkout (#728)", () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "--quiet", "-m", "init");
    const worktree = join(tmpRoot, "goosefish");
    git("worktree", "add", "--quiet", worktree);
    mkdirSync(join(worktree, "src"), { recursive: true });
    expect(resolveProject(worktree)).toBe(REPO_NAME);
    expect(resolveProject(join(worktree, "src"))).toBe(REPO_NAME);
  });

  it("falls back to basename(cwd) when not in a git repo", () => {
    // mkdtemp lands under os.tmpdir(), which is not always outside a repository —
    // TMPDIR pointed at a working directory makes git walk up and find one, and the
    // fallback under test never runs. Ceiling the upward search at the parent so the
    // directory is genuinely repo-less. The ceiling must be a resolved path: git
    // compares it after resolving symlinks, and on macOS tmpdir() is one.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "amem-noproj-")));
    const priorCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
    try {
      expect(resolveProject(dir)).toBe(basename(dir));
    } finally {
      if (priorCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = priorCeiling;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to process.cwd() when no cwd argument given", () => {
    vi.spyOn(process, "cwd").mockReturnValue(repoDir);
    expect(resolveProject()).toBe(REPO_NAME);
  });

  it("defaults to process.cwd() when cwd argument is empty", () => {
    vi.spyOn(process, "cwd").mockReturnValue(repoDir);
    expect(resolveProject("")).toBe(REPO_NAME);
    expect(resolveProject("   ")).toBe(REPO_NAME);
  });

  describe("same-named repos (rohitg00/agentmemory#733)", () => {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    const makeRepo = (parent: string, remote?: string) => {
      const dir = join(tmpRoot, parent, "shared-name");
      mkdirSync(dir, { recursive: true });
      git(dir, "init", "--quiet");
      if (remote) git(dir, "remote", "add", "origin", remote);
      return dir;
    };

    it("gives a second same-named repo with a different remote its own project", () => {
      const first = makeRepo("a", "git@example.com:one/shared-name.git");
      const second = makeRepo("b", "git@example.com:two/shared-name.git");
      expect(resolveProject(first)).toBe("shared-name");
      const suffixed = resolveProject(second);
      expect(suffixed).toMatch(/^shared-name-[0-9a-f]{6}$/);
      expect(resolveProject(first)).toBe("shared-name");
      expect(resolveProject(second)).toBe(suffixed);
    });

    it("tells same-named repos without a remote apart by their common dir", () => {
      const first = makeRepo("c");
      const second = makeRepo("d");
      expect(resolveProject(first)).toBe("shared-name");
      expect(resolveProject(second)).toMatch(/^shared-name-[0-9a-f]{6}$/);
    });

    it("keeps a repo with no collision under its bare name", () => {
      expect(resolveProject(repoDir)).toBe(REPO_NAME);
    });

    it("keeps worktrees of a suffixed repo in that repo's project", () => {
      const main = makeRepo("e", "git@example.com:one/shared-name.git");
      const other = makeRepo("f", "git@example.com:two/shared-name.git");
      git(other, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "--quiet", "-m", "i");
      const worktree = join(tmpRoot, "other-wt");
      git(other, "worktree", "add", "--quiet", worktree);
      expect(resolveProject(main)).toBe("shared-name");
      expect(resolveProject(other)).not.toBe("shared-name");
      expect(resolveProject(worktree)).toBe(resolveProject(other));
    });
  });
});
