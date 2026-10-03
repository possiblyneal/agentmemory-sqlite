#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
function hydrateEnvFromFile(isUnset) {
	for (const [key, value] of Object.entries(loadEnvFile())) if (isUnset(process.env[key])) process.env[key] = value;
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
function hookCwd(data) {
	if (!data || typeof data !== "object") return void 0;
	if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
	const projectDir = process.env["CLAUDE_PROJECT_DIR"];
	if (projectDir && projectDir.trim()) return projectDir;
}
//#endregion
//#region src/hooks/post-commit.ts
hydrateHookEnv();
const exec = promisify(execFile);
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const TIMEOUT_MS = 1500;
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
async function git(args, cwd) {
	try {
		const { stdout } = await exec("git", args, {
			cwd,
			timeout: 1500
		});
		return stdout.trim();
	} catch {
		return null;
	}
}
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data = {};
	if (input.trim()) try {
		data = JSON.parse(input);
	} catch {}
	if (!data || typeof data !== "object") data = {};
	if (shouldSkipSession()) return;
	const cwd = hookCwd(data) || process.env["AGENTMEMORY_CWD"] || process.cwd();
	const sessionId = data.session_id || process.env["AGENTMEMORY_SESSION_ID"] || void 0;
	const sha = process.env["AGENTMEMORY_COMMIT_SHA"] || await git(["rev-parse", "HEAD"], cwd);
	if (!sha) return;
	const branch = await git([
		"rev-parse",
		"--abbrev-ref",
		"HEAD"
	], cwd);
	const repo = await git([
		"config",
		"--get",
		"remote.origin.url"
	], cwd);
	const message = await git([
		"log",
		"-1",
		"--pretty=%B",
		sha
	], cwd);
	const author = await git([
		"log",
		"-1",
		"--pretty=%an <%ae>",
		sha
	], cwd);
	const authoredAt = await git([
		"log",
		"-1",
		"--pretty=%aI",
		sha
	], cwd);
	const filesRaw = await git([
		"diff-tree",
		"--no-commit-id",
		"--name-only",
		"-r",
		sha
	], cwd);
	const files = filesRaw ? filesRaw.split("\n").filter(Boolean) : void 0;
	const body = {
		sessionId,
		sha,
		branch: branch || void 0,
		repo: repo || void 0,
		message: message || void 0,
		author: author || void 0,
		authoredAt: authoredAt || void 0,
		files
	};
	try {
		await fetch(`${REST_URL}/agentmemory/session/commit`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch {}
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=post-commit.mjs.map