#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";
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
let envFileCache;
function loadEnvFile() {
	const path = join(homedir(), ".agentmemory", ".env");
	if (envFileCache?.path === path) return envFileCache.vars;
	let vars;
	try {
		vars = parseEnvFile(readFileSync(path, "utf-8"));
	} catch {
		vars = {};
	}
	envFileCache = {
		path,
		vars
	};
	return vars;
}
function hydrateEnvFromFile(isUnset) {
	for (const [key, value] of Object.entries(loadEnvFile())) if (isUnset(process.env[key])) process.env[key] = value;
}
function hydrateHookEnv() {
	hydrateEnvFromFile((current) => current === void 0);
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
		if (commonDir && basename(commonDir) === ".git") return basename(dirname(resolve(dir, commonDir)));
		if (top) return basename(top);
	} catch {}
	return basename(dir);
}
function hookCwd(data) {
	if (!data || typeof data !== "object") return void 0;
	if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
	const roots = data.workspace_roots;
	if (Array.isArray(roots)) {
		for (const root of roots) if (typeof root === "string" && root.trim()) return root;
	}
	const projectDir = process.env["DEVIN_PROJECT_DIR"] || process.env["CLAUDE_PROJECT_DIR"];
	if (projectDir && projectDir.trim()) return projectDir;
}
//#endregion
//#region src/hooks/_missed-injection.ts
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
//#region src/hooks/pre-tool-use.ts
hydrateHookEnv();
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
function contextPayload(data, context) {
	if (data.hook_event_name === "PreToolUse") return JSON.stringify({ hookSpecificOutput: {
		hookEventName: "PreToolUse",
		additionalContext: context
	} });
	return context;
}
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
async function main() {
	if (!INJECT_CONTEXT) return;
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
	const toolName = typeof data.tool_name === "string" ? data.tool_name : typeof data.toolName === "string" ? data.toolName : void 0;
	if (!toolName) return;
	const normalizedToolName = toolName.toLowerCase();
	if (![
		"edit",
		"write",
		"create",
		"read",
		"view",
		"glob",
		"grep"
	].includes(normalizedToolName)) return;
	const rawToolInput = data.tool_input ?? data.toolArgs;
	const toolInput = typeof rawToolInput === "object" && rawToolInput !== null && !Array.isArray(rawToolInput) ? rawToolInput : {};
	const files = [];
	const fileKeys = normalizedToolName === "grep" ? ["path", "file"] : [
		"file_path",
		"path",
		"file",
		"pattern"
	];
	for (const key of fileKeys) {
		const val = toolInput[key];
		if (typeof val === "string" && val.length > 0) files.push(val);
	}
	if (files.length === 0) return;
	const terms = [];
	if (normalizedToolName === "grep" || normalizedToolName === "glob") {
		const pattern = toolInput["pattern"];
		if (typeof pattern === "string" && pattern.length > 0) terms.push(pattern);
	}
	const rawSessionId = data.session_id || data.sessionId || data.conversation_id;
	const sessionId = typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : "unknown";
	const project = typeof data.project === "string" && data.project.trim().length > 0 ? data.project.trim() : resolveProject(hookCwd(data));
	try {
		const res = await fetch(`${REST_URL}/agentmemory/enrich`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				sessionId,
				files,
				terms,
				toolName,
				...project && { project }
			}),
			signal: AbortSignal.timeout(2e3)
		});
		if (res.ok) {
			const result = await res.json();
			if (result.context) process.stdout.write(contextPayload(data, result.context));
		} else recordMissedInjection("pre-tool-use", `http_${res.status}`);
	} catch (err) {
		recordMissedInjection("pre-tool-use", missReason(err));
	}
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=pre-tool-use.mjs.map