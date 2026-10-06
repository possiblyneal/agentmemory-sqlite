import { join } from "node:path";
import { homedir } from "node:os";
import { refreshBootVerbose } from "./logger.js";
import { hydrateEnvFromFile, loadEnvFile } from "./hooks/_env.js";
import pc from "picocolors";
import type {
  AgentMemoryConfig,
  ProviderType,
  ProviderConfig,
  EmbeddingConfig,
  FallbackConfig,
  ClaudeBridgeConfig,
  TeamConfig,
} from "./types.js";

function safeParseInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const DATA_DIR = join(homedir(), ".agentmemory");

export { __resetEnvFileCache } from "./hooks/_env.js";

let warnPremiumModelShown = false;

function hasRealValue(v: string | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// Hydrate ~/.agentmemory/.env into process.env at boot. loadEnvFile() is
// otherwise only consumed via getMergedEnv(), which the many modules that
// read raw process.env["X"] never call — so .env-only values were silently
// ignored by them. Copy the file's vars into process.env, but only when the
// key is currently unset so a real process.env value still wins (this
// preserves the {...fileEnv, ...process.env} precedence getMergedEnv uses).
export function hydrateProcessEnvFromFile(): void {
  hydrateEnvFromFile((current) => current === undefined);
  refreshBootVerbose();
}

export const DEFAULT_MODELS = {
  openai: { envKey: "OPENAI_MODEL", model: "gpt-5.6-luna" },
  anthropic: { envKey: "ANTHROPIC_MODEL", model: "claude-sonnet-5" },
  gemini: { envKey: "GEMINI_MODEL", model: "gemini-3.7-flash" },
  openrouter: { envKey: "OPENROUTER_MODEL", model: "anthropic/claude-sonnet-5" },
  minimax: { envKey: "MINIMAX_MODEL", model: "MiniMax-M3" },
  "agent-sdk": { envKey: null, model: "claude-sonnet-5" },
} satisfies Record<Exclude<ProviderType, "noop">, { envKey: string | null; model: string }>;

// Primary (detectProvider) and fallback (rohitg00/agentmemory#778) providers
// both resolve here, so a fallback never inherits the primary's model name.
export function resolveModel(
  provider: ProviderType,
  readEnv: (key: string) => string | undefined,
): string {
  if (provider === "noop") return "noop";
  const { envKey, model } = DEFAULT_MODELS[provider];
  return (envKey && readEnv(envKey)) || model;
}

function detectProvider(env: Record<string, string>): ProviderConfig {
  const readEnv = (key: string) => env[key];
  const maxTokens = parseInt(env["MAX_TOKENS"] || "4096", 10);

  // OpenAI-compatible: supports OpenAI, DeepSeek, SiliconFlow, Azure, vLLM, LM Studio
  if (hasRealValue(env["OPENAI_API_KEY"]) && env["OPENAI_API_KEY_FOR_LLM"] !== "false") {
    return {
      provider: "openai",
      model: resolveModel("openai", readEnv),
      maxTokens,
      baseURL: env["OPENAI_BASE_URL"],
    };
  }

  // MiniMax: Anthropic-compatible API, requires raw fetch to avoid SDK stainless headers
  if (hasRealValue(env["MINIMAX_API_KEY"])) {
    return {
      provider: "minimax",
      model: resolveModel("minimax", readEnv),
      maxTokens,
    };
  }

  if (hasRealValue(env["ANTHROPIC_API_KEY"])) {
    return {
      provider: "anthropic",
      model: resolveModel("anthropic", readEnv),
      maxTokens,
      baseURL: env["ANTHROPIC_BASE_URL"],
    };
  }
  if (hasRealValue(env["GEMINI_API_KEY"]) || hasRealValue(env["GOOGLE_API_KEY"])) {
    if (!hasRealValue(env["GEMINI_API_KEY"]) && hasRealValue(env["GOOGLE_API_KEY"])) {
      process.stderr.write(
        "[agentmemory] GOOGLE_API_KEY detected — treating as GEMINI_API_KEY. " +
          "Set GEMINI_API_KEY in ~/.agentmemory/.env to silence this warning.\n",
      );
    }
    return {
      provider: "gemini",
      model: resolveModel("gemini", readEnv),
      maxTokens,
    };
  }
  if (hasRealValue(env["OPENROUTER_API_KEY"])) {
    const model = resolveModel("openrouter", readEnv);
    // warn when the configured OpenRouter model is in the
    // premium tier and likely to burn money on background compression.
    // Captured workload data shows ~$5/35h on claude-sonnet-4 vs
    // ~$0.46/35h on deepseek-v4-pro for the same compression mix.
    // Heuristic match avoids hard-coding a pricing table.
    if (
      !warnPremiumModelShown &&
      /sonnet|opus|gpt-5\.\d+-sol|gpt-4o(?!.*mini)|gpt-4-turbo/i.test(model) &&
      env["AGENTMEMORY_SUPPRESS_COST_WARNING"] !== "1" &&
      env["AGENTMEMORY_SUPPRESS_COST_WARNING"] !== "true"
    ) {
      warnPremiumModelShown = true;
      process.stderr.write(
        `[agentmemory] OPENROUTER_MODEL=${model} is in the premium tier. ` +
          `Background compression on this model can cost $5+/day under active use. ` +
          `Cheaper alternatives with comparable quality for memory compression: ` +
          `deepseek/deepseek-v4-flash-0731, deepseek/deepseek-v4-pro, qwen/qwen3-coder. ` +
          `See README "Cost-aware model selection" for the full table. ` +
          `Set AGENTMEMORY_SUPPRESS_COST_WARNING=1 to silence.\n`,
      );
    }
    return {
      provider: "openrouter",
      model,
      maxTokens,
    };
  }

  const allowAgentSdk = env["AGENTMEMORY_ALLOW_AGENT_SDK"] === "true";
  if (!allowAgentSdk) {
    process.stderr.write(
      pc.dim(
        "[agentmemory] No LLM provider key set — running zero-LLM (BM25 + on-device embeddings). " +
          "Set ANTHROPIC_API_KEY (or GEMINI/OPENAI/OPENROUTER/MINIMAX) in ~/.agentmemory/.env for LLM compression and summaries. " +
          "Agent-SDK fallback stays off by default to avoid a Stop-hook recursion loop; opt in with AGENTMEMORY_AUTO_COMPRESS=true + AGENTMEMORY_ALLOW_AGENT_SDK=true.\n",
      ),
    );
    return {
      provider: "noop",
      model: "noop",
      maxTokens,
    };
  }

  process.stderr.write(
    "[agentmemory] WARNING: agent-sdk fallback enabled via AGENTMEMORY_ALLOW_AGENT_SDK=true. " +
      "This spawns @anthropic-ai/claude-agent-sdk child sessions that can trigger the Stop-hook " +
      "recursion loop. A SDK-child env marker is set to block re-entry, " +
      "but prefer setting a real API key in ~/.agentmemory/.env instead.\n",
  );
  return {
    provider: "agent-sdk",
    model: resolveModel("agent-sdk", readEnv),
    maxTokens,
  };
}

export function loadConfig(): AgentMemoryConfig {
  const env = getMergedEnv();

  const provider = detectProvider(env);

  // REST is the port anchor; streams derives from it unless overridden.
  // Default anchor 3111 yields 3112 for streams, but `III_REST_PORT=3211`
  // auto-picks 3212 so a second instance doesn't collide.
  const restPort = parseInt(env["III_REST_PORT"] || "3111", 10) || 3111;
  const streamsPort =
    parseInt(env["III_STREAM_PORT"] || env["III_STREAMS_PORT"] || "", 10) ||
    restPort + 1;

  return {
    restPort,
    streamsPort,
    provider,
    tokenBudget: safeParseInt(env["TOKEN_BUDGET"], 2000),
    maxObservationsPerSession: safeParseInt(env["MAX_OBS_PER_SESSION"], 2000),
    compressionModel: provider.model,
    dataDir: DATA_DIR,
  };
}

function getMergedEnv(
  overrides?: Record<string, string>,
): Record<string, string> {
  const fileEnv = loadEnvFile();
  return { ...fileEnv, ...process.env, ...overrides } as Record<string, string>;
}

export function getEnvVar(key: string): string | undefined {
  return getMergedEnv()[key];
}

// Claude Code reads only its own process environment, never ~/.agentmemory/.env.
function claudeConfigDirOverride(): string | undefined {
  const dir = process.env["CLAUDE_CONFIG_DIR"];
  return hasRealValue(dir) ? dir : undefined;
}

export function getClaudeConfigDir(): string {
  return claudeConfigDirOverride() ?? join(homedir(), ".claude");
}

export function getClaudeJsonPath(): string {
  const dir = claudeConfigDirOverride();
  return dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
}

export function getSqlitePath(): string {
  return (
    getEnvVar("AGENTMEMORY_SQLITE_PATH") ||
    join(getEnvVar("AGENTMEMORY_DATA_DIR") || DATA_DIR, "agentmemory.sqlite")
  );
}

export function getModelCacheDir(): string {
  return (
    getEnvVar("AGENTMEMORY_MODEL_CACHE_DIR") ||
    getEnvVar("XENOVA_CACHE_HOME") ||
    join(getEnvVar("AGENTMEMORY_DATA_DIR") || DATA_DIR, "models")
  );
}

export function detectLlmProviderKind(): "llm" | "noop" {
  const env = getMergedEnv();
  if (
    hasRealValue(env["ANTHROPIC_API_KEY"]) ||
    hasRealValue(env["GEMINI_API_KEY"]) ||
    hasRealValue(env["GOOGLE_API_KEY"]) ||
    hasRealValue(env["OPENROUTER_API_KEY"]) ||
    hasRealValue(env["MINIMAX_API_KEY"]) ||
    (hasRealValue(env["OPENAI_API_KEY"]) &&
      env["OPENAI_API_KEY_FOR_LLM"] !== "false")
  ) {
    return "llm";
  }
  return "noop";
}

export function loadEmbeddingConfig(): EmbeddingConfig {
  const env = getMergedEnv();
  let bm25Weight = parseFloat(env["BM25_WEIGHT"] || "0.4");
  let vectorWeight = parseFloat(env["VECTOR_WEIGHT"] || "0.6");
  bm25Weight =
    isNaN(bm25Weight) || bm25Weight < 0 ? 0.4 : Math.min(bm25Weight, 1);
  vectorWeight =
    isNaN(vectorWeight) || vectorWeight < 0 ? 0.6 : Math.min(vectorWeight, 1);
  return {
    provider: env["EMBEDDING_PROVIDER"] || undefined,
    bm25Weight,
    vectorWeight,
  };
}

const EMBEDDING_PROVIDERS = ["gemini", "openai", "voyage", "cohere", "openrouter", "local"];

export function embeddingConfigWarnings(env?: Record<string, string>): string[] {
  const source = env ?? getMergedEnv();
  const warnings: string[] = [];
  const forced = source["EMBEDDING_PROVIDER"];
  if (forced && !EMBEDDING_PROVIDERS.includes(forced)) {
    warnings.push(
      `EMBEDDING_PROVIDER="${forced}" is not recognised (use ${EMBEDDING_PROVIDERS.join(", ")}); running BM25-only`,
    );
  }
  if (source["AGENTMEMORY_EMBEDDING_PROVIDER"]) {
    warnings.push(
      "AGENTMEMORY_EMBEDDING_PROVIDER is ignored; the variable is named EMBEDDING_PROVIDER",
    );
  }
  return warnings;
}

export function detectEmbeddingProvider(
  env?: Record<string, string>,
): string | null {
  const source = env ?? getMergedEnv();
  const forced = source["EMBEDDING_PROVIDER"];
  if (forced) return forced;

  if (source["GEMINI_API_KEY"]) return "gemini";
  if (source["OPENAI_API_KEY"]) return "openai";
  if (source["VOYAGE_API_KEY"]) return "voyage";
  if (source["COHERE_API_KEY"]) return "cohere";
  if (source["OPENROUTER_API_KEY"]) return "openrouter";
  return null;
}

export function loadClaudeBridgeConfig(): ClaudeBridgeConfig {
  const env = getMergedEnv();
  const enabled = env["CLAUDE_MEMORY_BRIDGE"] === "true";
  const projectPath = env["CLAUDE_PROJECT_PATH"] || "";
  const lineBudget = safeParseInt(env["CLAUDE_MEMORY_LINE_BUDGET"], 200);
  let memoryFilePath = "";
  if (enabled && projectPath) {
    // Claude Code stores project memory at
    //   <claude config dir>/projects/<slug>/memory/MEMORY.md
    // where <slug> is the project path with `/` and `\` swapped for `-`.
    // The leading `-` from an absolute POSIX path is preserved (Claude
    // Code keeps it; stripping it produced a slug Claude never reads).
    // The `memory/` subdirectory holds MEMORY.md (the index) plus one
    // per-topic `.md` file per memory (verified against Claude Code 2.x).
    const safePath = projectPath.replace(/[/\\]/g, "-");
    memoryFilePath = join(
      getClaudeConfigDir(),
      "projects",
      safePath,
      "memory",
      "MEMORY.md",
    );
  }
  return { enabled, projectPath, memoryFilePath, lineBudget };
}

export function loadTeamConfig(): TeamConfig | null {
  const env = getMergedEnv();
  const teamId = env["TEAM_ID"];
  const userId = env["USER_ID"];
  if (!teamId || !userId) return null;
  const mode = env["TEAM_MODE"] === "shared" ? "shared" : "private";
  return { teamId, userId, mode };
}

// optional AGENT_ID env for multi-agent memory isolation.
// Returns null when unset so memory stays unscoped (legacy behavior).
// Trimmed + length-capped to keep KV writes well-formed.
//
// Filtering is gated by AGENTMEMORY_AGENT_SCOPE:
//   "shared"   (default) — tag everything, do not filter recall paths
//   "isolated"           — tag everything AND filter recall paths
export function loadAgentScope(): {
  agentId: string;
  mode: "shared" | "isolated";
} | null {
  const env = getMergedEnv();
  const raw = env["AGENT_ID"];
  if (!raw) return null;
  const agentId = raw.trim().slice(0, 128);
  if (!agentId) return null;
  const mode = env["AGENTMEMORY_AGENT_SCOPE"] === "isolated"
    ? "isolated"
    : "shared";
  return { agentId, mode };
}

export function getAgentId(): string | undefined {
  return loadAgentScope()?.agentId;
}

// True only when AGENT_ID is set AND scope=isolated. Recall paths
// consult this to decide whether to filter.
export function isAgentScopeIsolated(): boolean {
  return loadAgentScope()?.mode === "isolated";
}

// Floor for the git-snapshot timer. A zero/negative SNAPSHOT_INTERVAL would
// make setInterval fire on roughly every event-loop tick, saturating the
// worker with back-to-back full-state snapshots + git commits. Anything below
// this floor is treated as a misconfiguration and falls back to the default.
const SNAPSHOT_INTERVAL_DEFAULT_SECONDS = 3600;
const MIN_SNAPSHOT_INTERVAL_SECONDS = 1;
const SNAPSHOT_KEEP_DEFAULT = 48;

export function loadSnapshotConfig(): {
  enabled: boolean;
  interval: number;
  dir: string;
  keep: number;
} {
  const env = getMergedEnv();
  const rawInterval = safeParseInt(
    env["SNAPSHOT_INTERVAL"],
    SNAPSHOT_INTERVAL_DEFAULT_SECONDS,
  );
  const interval =
    rawInterval >= MIN_SNAPSHOT_INTERVAL_SECONDS
      ? rawInterval
      : SNAPSHOT_INTERVAL_DEFAULT_SECONDS;
  const rawKeep = safeParseInt(env["SNAPSHOT_KEEP"], SNAPSHOT_KEEP_DEFAULT);
  return {
    enabled: env["SNAPSHOT_ENABLED"] === "true",
    interval,
    keep: rawKeep >= 0 ? rawKeep : SNAPSHOT_KEEP_DEFAULT,
    dir: env["SNAPSHOT_DIR"] || join(homedir(), ".agentmemory", "snapshots"),
  };
}

export function isGraphExtractionEnabled(): boolean {
  return getMergedEnv()["GRAPH_EXTRACTION_ENABLED"] === "true";
}

// A1 (4A): suppress explicitly non-latest memories at the read paths.
//
// Ships DISABLED. The enable is gated on the step 5 supersession census,
// because A1 hides superseded rows from callers and the census is what
// decides whether those supersessions were correct. Enabling first would
// ship a user-visible visibility change on unaudited lineage.
//
// Off is byte-identical to pre-A1 behaviour, including the number of KV
// reads per search (asserted in test/nonlatest-filter.test.ts).
export function isNonLatestFilterEnabled(): boolean {
  return getMergedEnv()["AGENTMEMORY_NONLATEST_FILTER"] === "true";
}

export function getGraphBatchSize(): number {
  return safeParseInt(getMergedEnv()["GRAPH_EXTRACTION_BATCH_SIZE"], 10);
}

// #1168: provenance on a graph node or edge used to grow with every mention,
// unbounded, because every write site unioned ids and none ever trimmed. 50
// keeps enough evidence to trace a node back to recent work while making row
// size independent of how often the agent happens to touch a thing.
const MAX_SOURCE_OBSERVATION_IDS_DEFAULT = 50;

export function getMaxSourceObservationIds(): number {
  const parsed = safeParseInt(
    getMergedEnv()["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"],
    MAX_SOURCE_OBSERVATION_IDS_DEFAULT,
  );
  return parsed > 0 ? parsed : MAX_SOURCE_OBSERVATION_IDS_DEFAULT;
}

// #1172: the health judgement travels across machines with very different
// memory ceilings and load profiles, so every threshold that classifies a
// sample, and both counts that gate a verdict change, take an override named
// in HEALTH_ENV_KEYS below. A malformed value falls back to the default rather
// than producing a nonsense threshold.
export type HealthTuning = {
  eventLoopLagWarnMs: number;
  eventLoopLagCriticalMs: number;
  cpuWarnPercent: number;
  cpuCriticalPercent: number;
  memoryWarnPercent: number;
  memoryCriticalPercent: number;
  memoryRssFloorBytes: number;
  assertSamples: number;
  clearSamples: number;
};

export const HEALTH_TUNING_DEFAULTS: HealthTuning = {
  eventLoopLagWarnMs: 100,
  eventLoopLagCriticalMs: 500,
  cpuWarnPercent: 80,
  cpuCriticalPercent: 90,
  memoryWarnPercent: 80,
  memoryCriticalPercent: 95,
  memoryRssFloorBytes: 512 * 1024 * 1024,
  assertSamples: 3,
  clearSamples: 3,
};

const HEALTH_ENV_KEYS: Record<keyof HealthTuning, string> = {
  eventLoopLagWarnMs: "AGENTMEMORY_HEALTH_EVENT_LOOP_LAG_WARN_MS",
  eventLoopLagCriticalMs: "AGENTMEMORY_HEALTH_EVENT_LOOP_LAG_CRITICAL_MS",
  cpuWarnPercent: "AGENTMEMORY_HEALTH_CPU_WARN_PERCENT",
  cpuCriticalPercent: "AGENTMEMORY_HEALTH_CPU_CRITICAL_PERCENT",
  memoryWarnPercent: "AGENTMEMORY_HEALTH_MEMORY_WARN_PERCENT",
  memoryCriticalPercent: "AGENTMEMORY_HEALTH_MEMORY_CRITICAL_PERCENT",
  memoryRssFloorBytes: "AGENTMEMORY_HEALTH_MEMORY_RSS_FLOOR_BYTES",
  assertSamples: "AGENTMEMORY_HEALTH_ASSERT_SAMPLES",
  clearSamples: "AGENTMEMORY_HEALTH_CLEAR_SAMPLES",
};

// A sample count of zero would publish every sample unchallenged, which is
// not hysteresis at all - one is the floor, and it already means "no
// hysteresis". A threshold of zero is a real setting: it is how an Operator
// disables the RSS floor or asks to hear about any CPU at all.
const HEALTH_SAMPLE_COUNT_KEYS = new Set<keyof HealthTuning>([
  "assertSamples",
  "clearSamples",
]);

export function getHealthTuning(): HealthTuning {
  const env = getMergedEnv();
  const tuned = {} as HealthTuning;
  for (const key of Object.keys(HEALTH_TUNING_DEFAULTS) as (keyof HealthTuning)[]) {
    const fallback = HEALTH_TUNING_DEFAULTS[key];
    // `Number("")` is 0, so an env var set but left empty would read as a
    // deliberate zero rather than as the absence it is.
    const raw = env[HEALTH_ENV_KEYS[key]]?.trim();
    const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
    const floor = HEALTH_SAMPLE_COUNT_KEYS.has(key) ? 1 : 0;
    tuned[key] = Number.isFinite(parsed) && parsed >= floor ? parsed : fallback;
  }
  return tuned;
}

// window for the smart-search followup-rate diagnostic. A second
// search arriving within this many seconds (with disjoint results)
// counts as a "follow-up" — a directional signal that the first result
// set didn't satisfy. Long values overcount (legitimate refinement
// looks like a follow-up); short values undercount.
const FOLLOWUP_WINDOW_DEFAULT_SECONDS = 30;

export function getFollowupWindowSeconds(): number {
  return safeParseInt(
    getMergedEnv()["AGENTMEMORY_FOLLOWUP_WINDOW_SECONDS"],
    FOLLOWUP_WINDOW_DEFAULT_SECONDS,
  );
}

const IDLE_SESSION_DEFAULT_HOURS = 6;

export function getIdleSessionMs(): number {
  const hours = safeParseInt(
    getMergedEnv()["SESSION_IDLE_CLOSE_HOURS"],
    IDLE_SESSION_DEFAULT_HOURS,
  );
  return (hours > 0 ? hours : IDLE_SESSION_DEFAULT_HOURS) * 60 * 60 * 1000;
}

const SIGNAL_TTL_DEFAULT_DAYS = 30;

export function getSignalDefaultTtlMs(): number {
  const days = safeParseInt(
    getMergedEnv()["AGENTMEMORY_SIGNAL_TTL_DAYS"],
    SIGNAL_TTL_DEFAULT_DAYS,
  );
  return days > 0 ? days * 24 * 60 * 60 * 1000 : 0;
}

const BACKUP_KEEP_DEFAULT = 7;

export function getBackupKeep(): number {
  const keep = safeParseInt(getMergedEnv()["AGENTMEMORY_BACKUP_KEEP"], BACKUP_KEEP_DEFAULT);
  return keep >= 0 ? keep : BACKUP_KEEP_DEFAULT;
}

const INSIGHT_MAX_IDLE_WEEKS_DEFAULT = 26;

export function getInsightMaxIdleWeeks(): number {
  const weeks = safeParseInt(
    getMergedEnv()["AGENTMEMORY_INSIGHT_MAX_IDLE_WEEKS"],
    INSIGHT_MAX_IDLE_WEEKS_DEFAULT,
  );
  return weeks > 0 ? weeks : INSIGHT_MAX_IDLE_WEEKS_DEFAULT;
}

export function isConsolidationEnabled(): boolean {
  const env = getMergedEnv();
  const explicit = env["CONSOLIDATION_ENABLED"];
  if (explicit === "false" || explicit === "0") return false;
  if (explicit === "true" || explicit === "1") return true;
  return hasLLMProviderConfigured(env);
}

function hasLLMProviderConfigured(env: Record<string, string | undefined>): boolean {
  const provider = (env["AGENTMEMORY_PROVIDER"] || "").toLowerCase();
  if (provider === "noop") return false;
  const openaiKeyForLlm =
    env["OPENAI_API_KEY"] &&
    (env["OPENAI_API_KEY_FOR_LLM"] || "").toLowerCase() !== "false";
  return Boolean(
    env["ANTHROPIC_API_KEY"] ||
      openaiKeyForLlm ||
      env["OPENROUTER_API_KEY"] ||
      env["GEMINI_API_KEY"] ||
      env["GOOGLE_API_KEY"] ||
      env["MINIMAX_API_KEY"] ||
      env["OPENAI_BASE_URL"] ||
      provider === "agent-sdk",
  );
}

// Per-observation LLM compression is OFF by default as of 0.8.8.
// When disabled, observations are captured and indexed via a synthetic
// (zero-LLM) compression path so recall/search still works. Users who want
// richer LLM-generated summaries can set AGENTMEMORY_AUTO_COMPRESS=true in
// ~/.agentmemory/.env — but should expect their Claude API token usage to
// climb proportionally with session tool-use frequency.
export function isAutoCompressEnabled(): boolean {
  return getMergedEnv()["AGENTMEMORY_AUTO_COMPRESS"] === "true";
}

// Hook-level context injection into Claude Code's conversation is OFF by
// default as of 0.8.10. When disabled, hooks still POST observations for
// background capture but never write context to stdout. Session-start and
// per-prompt Injection opt in with AGENTMEMORY_INJECT_CONTEXT=true.
export function isContextInjectionEnabled(): boolean {
  return getMergedEnv()["AGENTMEMORY_INJECT_CONTEXT"] === "true";
}

export function getConsolidationDecayDays(): number {
  return safeParseInt(getMergedEnv()["CONSOLIDATION_DECAY_DAYS"], 30);
}

export function getConsolidatedMemoryForgetDays(): number {
  const days = safeParseInt(getMergedEnv()["CONSOLIDATED_MEMORY_FORGET_DAYS"], 180);
  return days > 0 ? days : 0;
}

// Cooldown between corpus consolidations triggered by session stop. The Stop
// hook fires per agent turn and posts /session/end, so without this every turn
// would kick a full LLM semantic-merge + reflect + crystallize. Debounced to at
// most once per window. Set to 0 to disable the debounce (consolidate on every
// stop). Default 5 minutes.
const CONSOLIDATION_COOLDOWN_DEFAULT_MS = 300000;

export function getConsolidationCooldownMs(): number {
  const raw = safeParseInt(
    getMergedEnv()["AGENTMEMORY_CONSOLIDATION_COOLDOWN_MS"],
    CONSOLIDATION_COOLDOWN_DEFAULT_MS,
  );
  return raw >= 0 ? raw : CONSOLIDATION_COOLDOWN_DEFAULT_MS;
}

export function isStandaloneMcp(): boolean {
  return getMergedEnv()["STANDALONE_MCP"] === "true";
}

export function getStandalonePersistPath(): string {
  const env = getMergedEnv();
  return (
    env["STANDALONE_PERSIST_PATH"] ||
    join(homedir(), ".agentmemory", "standalone.json")
  );
}

const VALID_PROVIDERS = new Set([
  "anthropic",
  "gemini",
  "openrouter",
  "agent-sdk",
  "minimax",
  "openai",
]);

export function loadFallbackConfig(): FallbackConfig {
  const env = getMergedEnv();
  const raw = env["FALLBACK_PROVIDERS"] || "";
  const allowAgentSdk = env["AGENTMEMORY_ALLOW_AGENT_SDK"] === "true";
  const providers = raw
    .split(",")
    .map((p) => p.trim())
    .filter(
      (p): p is FallbackConfig["providers"][number] =>
        Boolean(p) && VALID_PROVIDERS.has(p),
    )
    .filter((p) => {
      // Honor the same safety gate as detectProvider: agent-sdk is only
      // permitted as a fallback target when the user has explicitly opted
      // in. Without this filter, a user could set FALLBACK_PROVIDERS=agent-sdk
      // and re-introduce the Stop-hook recursion loop even though
      // detectProvider() returned the noop provider.
      if (p === "agent-sdk" && !allowAgentSdk) {
        process.stderr.write(
          "[agentmemory] Ignoring FALLBACK_PROVIDERS entry 'agent-sdk' " +
            "(AGENTMEMORY_ALLOW_AGENT_SDK is not 'true'). The agent-sdk " +
            "fallback can spawn Claude Agent SDK child sessions that trigger " +
            "the Stop-hook recursion loop. Opt in explicitly " +
            "with AGENTMEMORY_ALLOW_AGENT_SDK=true if this is intentional.\n",
        );
        return false;
      }
      return true;
    });
  return { providers };
}
