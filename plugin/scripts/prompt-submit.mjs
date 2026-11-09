#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
//#region src/hooks/_env.ts
function parseEnvFile(content) {
	const vars = {};
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		let val = trimmed.slice(eqIdx + 1).trim();
		const quoteChar = val[0] === "\"" || val[0] === "'" ? val[0] : "";
		if (quoteChar) {
			const closeIdx = val.indexOf(quoteChar, 1);
			if (closeIdx !== -1) val = val.slice(1, closeIdx);
		} else {
			const hashIdx = val.indexOf(" #");
			if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
		}
		vars[key] = val;
	}
	return vars;
}
function envFilePath() {
	return join(homedir(), ".agentmemory", ".env");
}
function readEnvFile() {
	try {
		return parseEnvFile(readFileSync(envFilePath(), "utf-8"));
	} catch (err) {
		if (err.code === "ENOENT") return {};
		throw err;
	}
}
let envFileCache;
function loadEnvFile() {
	const path = envFilePath();
	if (envFileCache?.path === path) return envFileCache.vars;
	const vars = readEnvFile();
	envFileCache = {
		path,
		vars
	};
	return vars;
}
const NOT_HYDRATED = new Set(["CLAUDE_CONFIG_DIR"]);
function hydrateEnvFromFile(isUnset) {
	for (const [key, value] of Object.entries(loadEnvFile())) {
		if (NOT_HYDRATED.has(key)) continue;
		if (isUnset(process.env[key])) process.env[key] = value;
	}
}
function hydrateHookEnv() {
	try {
		hydrateEnvFromFile((current) => current === void 0);
	} catch {}
}
//#endregion
//#region src/hooks/sdk-guard.ts
/**
* Skip guard shared by every hook script.
*
* Two kinds of Session never reach agentmemory:
*
*   1. agentmemory's own summarize/compress calls. The agent-sdk provider
*      sets AGENTMEMORY_SDK_CHILD=1 before it spawns `query()`, and the
*      child inherits it. Capturing that child would summarize it through
*      the same provider and recurse without bound (#149 follow-up). This
*      skip is unconditional.
*   2. Headless Sessions: any CLAUDE_CODE_ENTRYPOINT starting "sdk-", which
*      today is `claude -p` ("sdk-cli"), the TS Agent SDK ("sdk-ts") and
*      the Python Agent SDK ("sdk-py"). These are almost always scripted
*      batches whose summaries are noise, and a batch of thousands
*      saturates the summarizing LLM. Set AGENTMEMORY_CAPTURE_HEADLESS=1
*      to capture them.
*
* Claude Code puts the entrypoint in the hook's environment, never in the
* stdin payload.
*/
function shouldSkipSession() {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (process.env["AGENTMEMORY_CAPTURE_HEADLESS"] === "1") return false;
	return process.env["CLAUDE_CODE_ENTRYPOINT"]?.startsWith("sdk-") ?? false;
}
//#endregion
//#region src/hooks/_project.ts
function projectNamesPath() {
	return join(homedir(), ".agentmemory", "project-names.json");
}
function remoteUrl(dir) {
	try {
		return execSync("git config --get remote.origin.url", {
			cwd: dir,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 500
		}).toString().trim().replace(/\.git$/, "");
	} catch {
		return "";
	}
}
function disambiguate(name, commonDir, dir) {
	const identity = remoteUrl(dir) || commonDir;
	try {
		const path = projectNamesPath();
		let claims = {};
		try {
			claims = JSON.parse(readFileSync(path, "utf-8"));
		} catch {}
		if (!(name in claims)) {
			mkdirSync(dirname(path), { recursive: true });
			const staged = `${path}.${process.pid}`;
			writeFileSync(staged, JSON.stringify({
				...claims,
				[name]: identity
			}));
			renameSync(staged, path);
			return name;
		}
		if (claims[name] === identity) return name;
		return `${name}-${createHash("sha1").update(identity).digest("hex").slice(0, 6)}`;
	} catch {
		return name;
	}
}
function resolveProject(cwd) {
	const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
	if (explicit && explicit.trim()) return explicit.trim();
	return resolveGitProject(cwd && cwd.trim() ? cwd : process.cwd());
}
function bareRepoName(commonDir) {
	const name = basename(commonDir);
	if (name === ".bare") return basename(dirname(commonDir));
	return name.replace(/\.git$/, "");
}
function resolveGitProject(dir) {
	try {
		const [commonDir, top] = execSync("git rev-parse --git-common-dir --show-toplevel", {
			cwd: dir,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 500
		}).toString().trim().split("\n");
		if (commonDir && basename(commonDir) === ".git") return disambiguate(basename(dirname(resolve(dir, commonDir))), resolve(dir, commonDir), dir);
		if (top && commonDir && resolve(dir, commonDir) !== resolve(top, ".git")) {
			const bare = resolve(dir, commonDir);
			if (!bare.split(/[\\/]/).includes("modules")) return disambiguate(bareRepoName(bare), bare, dir);
		}
		if (top) return disambiguate(basename(top), resolve(dir, commonDir || top), dir);
	} catch {}
	return basename(dir);
}
function hookCwd(data) {
	if (!data || typeof data !== "object") return void 0;
	if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
	const projectDir = process.env["CLAUDE_PROJECT_DIR"];
	if (projectDir && projectDir.trim()) return projectDir;
}
//#endregion
//#region src/hooks/_missed-injection.ts
const INJECT_TIMEOUT_MS = 1500;
const MAX_BYTES = 256 * 1024;
const KEEP_ENTRIES = 1e3;
function missedInjectionsPath() {
	return join(homedir(), ".agentmemory", "missed-injections.jsonl");
}
function missReason(err) {
	return err instanceof Error && err.name === "TimeoutError" ? "timeout" : "connection";
}
function recordMissedInjection(hook, reason) {
	try {
		const path = missedInjectionsPath();
		mkdirSync(join(homedir(), ".agentmemory"), { recursive: true });
		const entry = {
			at: (/* @__PURE__ */ new Date()).toISOString(),
			hook,
			reason
		};
		appendFileSync(path, JSON.stringify(entry) + "\n");
		if (statSync(path).size > MAX_BYTES) writeFileSync(path, readFileSync(path, "utf-8").trimEnd().split("\n").slice(-KEEP_ENTRIES).join("\n") + "\n");
	} catch {}
}
//#endregion
//#region src/utils/harness-message.ts
const TAGS = "task-notification|teammate-message|cross-session-message|agent-message";
const OPENS_WITH_TAG = new RegExp(`^<(${TAGS})[\\s>]`);
const LEADING_ELEMENT = new RegExp(`^<(${TAGS})[\\s>][\\s\\S]*?</\\1>\\s*`);
function isHarnessMessage(prompt) {
	let rest = prompt.trim();
	if (!OPENS_WITH_TAG.test(rest)) return false;
	for (let m; m = LEADING_ELEMENT.exec(rest);) rest = rest.slice(m[0].length);
	return rest === "" || OPENS_WITH_TAG.test(rest);
}
const NOT_A_HUMAN_TURN = [
	/^<command-(name|message|args)>/,
	/^<local-command-/,
	/^<bash-(input|stdout|stderr)>/,
	/^\[Request interrupted/,
	/^Caveat:/,
	/^Base directory for this skill:/,
	/^This session is being continued from a previous conversation/,
	/^Another Claude session sent a message:\s*<teammate-message[\s>]/
];
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
function isOperatorTurn(prompt) {
	return !NOT_A_HUMAN_TURN.some((re) => re.test(prompt)) && prompt.replace(SYSTEM_REMINDER, "").trim() !== "";
}
//#endregion
//#region src/utils/terse-prompt.ts
const STOPWORDS = new Set("the and for that this with you your are was were have has had not but can could would should will just from they them then than into about what when where which while there their here also its our out all any more some been being does did doing done get got make made use using please want need like let's lets one two now still".split(" "));
const TERSE_BELOW_TOKENS = 3;
const MAX_REPLY_QUERY_CHARS = 1e3;
function contentTokens(text) {
	const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9_./-]*[a-z0-9]|[a-z0-9]/g) ?? [];
	return new Set(tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t)));
}
function isTersePrompt(text) {
	return contentTokens(text).size < TERSE_BELOW_TOKENS;
}
//#endregion
//#region src/hooks/_last-reply.ts
const TAIL_BYTES = 256 * 1024;
function blocks(entry) {
	const content = entry.message?.content;
	return Array.isArray(content) ? content : [];
}
function typedText(entry) {
	const content = entry.message?.content;
	if (typeof content !== "string" || entry.isMeta || entry.isCompactSummary) return void 0;
	const text = content.trim();
	return isOperatorTurn(text) && !isHarnessMessage(text) ? text : void 0;
}
async function lastAgentReply(transcriptPath, prompt) {
	const file = await open(transcriptPath, "r");
	try {
		const { size } = await file.stat();
		const length = Math.min(TAIL_BYTES, size);
		const { buffer } = await file.read(Buffer.alloc(length), 0, length, size - length);
		const reply = [];
		let passedCurrent = false;
		for (const line of buffer.toString("utf8").split("\n").reverse()) {
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.isSidechain) continue;
			if (entry.type === "user") {
				if (reply.length > 0 || blocks(entry).some((b) => b.type === "tool_result")) break;
				const typed = typedText(entry);
				if (typed === void 0) continue;
				if (passedCurrent || typed !== prompt.trim()) break;
				passedCurrent = true;
			} else if (entry.type === "assistant") {
				const texts = blocks(entry).flatMap((b) => b.type === "text" && b.text ? [b.text] : []);
				reply.unshift(...texts);
			}
		}
		return reply.join("\n\n").trim().slice(-MAX_REPLY_QUERY_CHARS);
	} finally {
		await file.close();
	}
}
function withinDeadline(read, ms) {
	return Promise.race([read.catch(() => ""), new Promise((resolve) => setTimeout(() => resolve(""), ms).unref())]);
}
//#endregion
//#region src/hooks/prompt-submit.ts
hydrateHookEnv();
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (!data || typeof data !== "object") return;
	if (shouldSkipSession()) return;
	const sessionId = data.session_id || "unknown";
	const cwd = hookCwd(data) || process.cwd();
	const project = resolveProject(cwd);
	const prompt = data.prompt;
	const timestamp = (/* @__PURE__ */ new Date()).toISOString();
	if (INJECT_CONTEXT && data.hook_event_name === "UserPromptSubmit" && !data.agent_id && typeof prompt === "string") await injectContext(sessionId, project, prompt, data.transcript_path);
	fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "prompt_submit",
			sessionId,
			project,
			cwd,
			timestamp,
			data: { prompt }
		}),
		signal: AbortSignal.timeout(3e3)
	}).catch(() => {});
	setTimeout(() => process.exit(0), 500).unref();
}
const REPLY_READ_TIMEOUT_MS = 200;
async function replyFor(prompt, transcriptPath) {
	if (!isTersePrompt(prompt) || typeof transcriptPath !== "string") return "";
	return withinDeadline(lastAgentReply(transcriptPath, prompt), REPLY_READ_TIMEOUT_MS);
}
async function injectContext(sessionId, project, prompt, transcriptPath) {
	try {
		const reply = await replyFor(prompt, transcriptPath);
		const res = await fetch(`${REST_URL}/agentmemory/prompt-context`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				sessionId,
				project,
				prompt,
				...reply && { reply }
			}),
			signal: AbortSignal.timeout(INJECT_TIMEOUT_MS)
		});
		if (!res.ok) {
			recordMissedInjection("prompt-submit", `http_${res.status}`);
			return;
		}
		const result = await res.json();
		if (result.context) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
			hookEventName: "UserPromptSubmit",
			additionalContext: result.context
		} }));
	} catch (err) {
		recordMissedInjection("prompt-submit", missReason(err));
	}
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=prompt-submit.mjs.map