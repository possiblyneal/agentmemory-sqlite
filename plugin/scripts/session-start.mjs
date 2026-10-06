#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
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
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
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
//#region src/hooks/session-start.ts
hydrateHookEnv();
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const REGISTER_TIMEOUT_MS = 800;
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
function contextPayload(data, context) {
	if (data.prompt_id !== void 0) return JSON.stringify({ hookSpecificOutput: {
		hookEventName: "SessionStart",
		additionalContext: context
	} });
	return context;
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
	if (typeof data.agent_id === "string" && data.agent_id) return;
	const sessionId = data.session_id || `ses_${Date.now().toString(36)}`;
	const cwd = hookCwd(data) || process.cwd();
	const project = resolveProject(cwd);
	const url = `${REST_URL}/agentmemory/session/start`;
	const init = {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			sessionId,
			project,
			cwd
		})
	};
	if (!INJECT_CONTEXT) {
		fetch(url, {
			...init,
			signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS)
		}).catch(() => {});
		return;
	}
	try {
		const res = await fetch(url, {
			...init,
			signal: AbortSignal.timeout(INJECT_TIMEOUT_MS)
		});
		if (res.ok) {
			const result = await res.json();
			if (result.context) process.stdout.write(contextPayload(data, result.context));
		} else recordMissedInjection("session-start", `http_${res.status}`);
	} catch (err) {
		recordMissedInjection("session-start", missReason(err));
	}
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=session-start.mjs.map