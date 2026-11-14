import { configDefaults, defineConfig } from "vitest/config";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";

// Tests must never see the developer's real $HOME: config.ts reads
// ~/.agentmemory/.env underneath process.env, so asserted defaults would
// silently become whatever the local install happens to set — red on clean
// checkouts, green on machines whose .env masks a broken default. Point HOME
// at a throwaway directory for the whole run; tests that need home-dir state
// create their own sandbox and reset HOME themselves.
const testHome = mkdtempSync(join(tmpdir(), "agentmemory-test-home-"));

// Re-importing the source for every file was half the suite's CPU, so files
// that can share a module graph run in one per worker. A file needs its own
// when it mocks a module, or when it asserts on state a module captures at
// import (config.ts's DATA_DIR from $HOME, _env.ts's env-file cache, ...).
const FRESH_MODULES = new Set([
  "cli-connect", "consolidation-default", "fetch-lazy-undici", "hook-env", "hook-project",
  "live-stream", "local-embedding-provider", "mcp-lesson-queue", "mcp-standalone-proxy",
  "openai-reply", "preferences", "slots-flag-gate", "viewer-proxy-prefix", "viewer-security",
].map((name) => `test/${name}.test.ts`));
const sharesModules = (file: string) =>
  !FRESH_MODULES.has(file) && !/\bvi\.(do)?[mM]ock\(/.test(readFileSync(file, "utf8"));
const INTEGRATION = "test/integration.test.ts";
const testFiles = readdirSync("test")
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `test/${name}`)
  .filter((file) => file !== INTEGRATION);

// Vitest's fs module cache keeps transformed modules between runs, which
// takes the transform off the main process every worker waits on. It writes
// each entry by rename without fsync, so a power cut can leave one torn, and
// a torn entry fails every run that loads it. Drop any entry whose trailing
// metadata does not parse before the run reads them (~30 ms for 500 entries).
const MODULE_CACHE = "node_modules/.experimental-vitest-cache";
const CACHE_MARKER = "\n//# vitestCache=";
function dropTornCacheEntries() {
  if (!existsSync(MODULE_CACHE)) return;
  for (const name of readdirSync(MODULE_CACHE)) {
    if (!/^[0-9a-f]{40}$/.test(name)) continue;
    const entry = join(MODULE_CACHE, name);
    const code = readFileSync(entry, "utf8");
    const marker = code.lastIndexOf(CACHE_MARKER);
    if (marker === -1) continue;
    try {
      JSON.parse(Buffer.from(code.slice(marker + CACHE_MARKER.length), "base64").toString("utf8"));
    } catch {
      rmSync(entry, { force: true });
    }
  }
}
// CI starts with an empty cache, so there it would only add writes.
const useModuleCache = !process.env.CI;
if (useModuleCache) dropTornCacheEntries();

export default defineConfig({
  test: {
    experimental: { fsModuleCache: useModuleCache },
    exclude: [...configDefaults.exclude, "tmp/**", ".claude/**"],
    env: {
      HOME: testHome,
      USERPROFILE: testHome,
      AGENTMEMORY_PROMPT_RERANK: "off",
    },
    projects: [
      // CI isolates every file, so state one file leaks can never turn
      // another's assertion green unnoticed.
      { extends: true, test: { name: "shared", include: testFiles.filter(sharesModules), isolate: !!process.env.CI } },
      { extends: true, test: { name: "isolated", include: testFiles.filter((file) => !sharesModules(file)) } },
      { extends: true, test: { name: "integration", include: [INTEGRATION] } },
    ],
  },
});
