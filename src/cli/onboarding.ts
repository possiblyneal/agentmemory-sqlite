// First-run interactive onboarding flow.
//
// Wakes up only when `isFirstRun()` is true (preferences are missing or
// have never recorded a `firstRunAt`) or when the user passes
// `--reset`. The flow asks which LLM provider to use for compress /
// consolidate / graph. "skip — BM25-only mode" is a real first-class
// option; lots of users want agentmemory purely as a hybrid keyword +
// vector memory layer without granting LLM API keys.
//
// We then write `~/.agentmemory/preferences.json`, seed
// `~/.agentmemory/.env` with a commented-out `*_API_KEY=` line for the
// chosen provider, and offer to wire Claude Code's MCP entry. The .env
// step matches `agentmemory init` closely so users who skip onboarding
// still get the same file via `agentmemory init`.

import { copyFile, mkdir } from "node:fs/promises";
import { constants as fsConstants, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { appendFileSync, readFileSync } from "node:fs";
import { DEFAULT_MODELS } from "../config.js";
import { readPrefs, writePrefs } from "./preferences.js";
import { installClaudeCode } from "./connect/claude-code.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROVIDERS: { value: string; label: string; envKey: string | null }[] = [
  { value: "anthropic", label: "Anthropic — claude", envKey: "ANTHROPIC_API_KEY" },
  { value: "openai", label: "OpenAI — gpt", envKey: "OPENAI_API_KEY" },
  { value: "gemini", label: "Google — gemini", envKey: "GEMINI_API_KEY" },
  { value: "openrouter", label: "OpenRouter — multi-model", envKey: "OPENROUTER_API_KEY" },
  { value: "minimax", label: `MiniMax — ${DEFAULT_MODELS.minimax.model}`, envKey: "MINIMAX_API_KEY" },
  { value: "skip", label: "Skip — BM25-only mode (no LLM key)", envKey: null },
];

const PROVIDER_COST_HINTS: Record<string, string> = {
  anthropic: "rough cost: a fast Haiku-class model keeps compress/consolidate at fractions of a cent per session.",
  openai: "rough cost: a mini-class model keeps compress/consolidate at fractions of a cent per session.",
  gemini: "rough cost: a Flash-class model keeps compress/consolidate at fractions of a cent per session.",
  openrouter: "rough cost: pick a small model; spend tracks your chosen model's per-token price.",
  minimax: "rough cost: scales with the MiniMax model price per token.",
};

// Mirror src/cli.ts findEnvExample so onboarding ships the same .env
// skeleton whether called directly or via `agentmemory init`. We
// duplicate (rather than import) so the onboarding module doesn't
// pull cli.ts's top-level side effects into the test runner.
function findEnvExample(): string | null {
  const candidates = [
    join(__dirname, "..", "..", ".env.example"),
    join(__dirname, "..", ".env.example"),
    join(__dirname, ".env.example"),
    join(process.cwd(), ".env.example"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

async function seedEnvFile(provider: string | null): Promise<string | null> {
  const target = join(homedir(), ".agentmemory", ".env");
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });

  const template = findEnvExample();
  if (template && !existsSync(target)) {
    try {
      await copyFile(template, target, fsConstants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        return null;
      }
    }
  } else if (!template && !existsSync(target)) {
    // Fall back to a minimal skeleton so users always get a `.env` to
    // edit. This matches the shape of the bundled `.env.example`
    // without forcing us to keep two copies in sync.
    const lines = [
      "# agentmemory environment — uncomment what you need",
      "# AGENTMEMORY_URL=http://localhost:3111",
      "",
    ];
    const envKey = PROVIDERS.find((x) => x.value === provider)?.envKey;
    if (envKey) {
      lines.push(`# ${envKey}=`);
    }
    writeFileSync(target, lines.join("\n"), { mode: 0o600 });
  }

  return target;
}

export interface OnboardingResult {
  provider: string | null;
}

function shouldSkipInteractiveOnboarding(): boolean {
  const ci = process.env["CI"];
  return (
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true ||
    (ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false")
  );
}

function writeDefaultOnboardingPrefs(): OnboardingResult {
  writePrefs({
    lastAgent: null,
    lastAgents: [],
    lastProvider: null,
    skipSplash: true,
    firstRunAt: new Date().toISOString(),
  });
  return { provider: null };
}

export async function runOnboarding(): Promise<OnboardingResult> {
  if (shouldSkipInteractiveOnboarding()) {
    return writeDefaultOnboardingPrefs();
  }

  p.note(
    [
      "Welcome to agentmemory.",
      "",
      "Persistent memory for Claude Code. We'll pick which provider (if any)",
      "handles compression and consolidation, then offer to wire Claude Code.",
      "The provider can be changed later in ~/.agentmemory/.env.",
    ].join("\n"),
    "first-run setup",
  );

  const providerPicked = await p.select<string>({
    message: "Which LLM provider should agentmemory use for compress/consolidate?",
    options: PROVIDERS.map(({ value, label }) => ({ value, label })),
    initialValue: "anthropic",
  });
  if (p.isCancel(providerPicked)) {
    p.cancel("Setup cancelled. Re-run any time with: agentmemory --reset");
    process.exit(0);
  }

  const provider = providerPicked === "skip" ? null : providerPicked;

  if (provider) {
    const hint = PROVIDER_COST_HINTS[provider];
    if (hint) {
      p.log.info(hint);
    }
  }

  const envPath = await seedEnvFile(provider);

  await maybePromptContextInjection(envPath);

  writePrefs({
    lastProvider: provider,
    skipSplash: true,
    firstRunAt: new Date().toISOString(),
  });

  const prefsLocation = join(homedir(), ".agentmemory", "preferences.json");
  const lines = [`✓ Saved preferences to ${prefsLocation}`];
  if (envPath) {
    lines.push(`✓ Wrote ${envPath} (edit to add your API key)`);
  } else {
    lines.push(`! Could not write ~/.agentmemory/.env — run \`agentmemory init\` after this completes.`);
  }
  if (provider) {
    const envKey = PROVIDERS.find((x) => x.value === provider)?.envKey;
    if (envKey) {
      lines.push(`  Uncomment ${envKey}= in that file to enable ${provider}.`);
    }
  } else {
    lines.push("  No provider chosen — agentmemory will run in BM25-only mode.");
  }
  p.note(lines.join("\n"), "ready");

  await offerClaudeCodeWiring();

  return { provider };
}

function enableInjectContextInEnv(envPath: string | null): boolean {
  if (!envPath || !existsSync(envPath)) return false;
  try {
    const current = readFileSync(envPath, "utf-8");
    if (/^\s*AGENTMEMORY_INJECT_CONTEXT\s*=\s*true\b/m.test(current)) {
      return true;
    }
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    appendFileSync(envPath, `${prefix}AGENTMEMORY_INJECT_CONTEXT=true\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

async function maybePromptContextInjection(envPath: string | null): Promise<void> {
  if (readPrefs().injectContextChosen) return;

  const enable = await p.confirm({
    message: "Enable automatic context injection so the agent recalls past sessions without being asked? [y/N]",
    initialValue: false,
  });

  if (p.isCancel(enable)) {
    p.cancel("Setup cancelled. Re-run any time with: agentmemory --reset");
    process.exit(0);
  }

  p.log.info(
    "Cost note: injection adds a recalled-context block at each session start and a short one on prompts with strong matches. Default is off.",
  );

  writePrefs({ injectContextChosen: true });

  if (enable === true) {
    const wrote = enableInjectContextInEnv(envPath);
    if (wrote) {
      p.log.success("Context injection enabled (AGENTMEMORY_INJECT_CONTEXT=true).");
    } else {
      p.log.warn(
        "Could not update ~/.agentmemory/.env. Set AGENTMEMORY_INJECT_CONTEXT=true there to enable it.",
      );
    }
  } else {
    p.log.info("Context injection left off. Set AGENTMEMORY_INJECT_CONTEXT=true later to enable.");
  }
}

async function offerClaudeCodeWiring(): Promise<void> {
  p.note(
    [
      "The marketplace plugin installs the MCP server, hooks and skills:",
      "  /plugin marketplace add possiblyneal/agentmemory-sqlite",
      "  /plugin install agentmemory",
      "`agentmemory connect` wires the MCP server only.",
    ].join("\n"),
    "Claude Code",
  );
  const confirmed = await p.confirm({
    message: "Run `agentmemory connect` to wire Claude Code's MCP server now? [Y/n]",
    initialValue: true,
  });

  if (p.isCancel(confirmed) || confirmed === false) {
    p.note("Wire later with:\n  agentmemory connect", "later");
    return;
  }

  try {
    const result = await installClaudeCode({ dryRun: false, force: false });
    if (result.kind === "skipped") {
      p.log.warn(`Claude Code was not wired (${result.reason}).`);
    }
  } catch (err) {
    p.log.error(`Claude Code: ${err instanceof Error ? err.message : String(err)}`);
  }
}
