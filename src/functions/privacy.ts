import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ISdk } from "../engine/types.js";

const RULES_LIMIT = 64 * 1024;
export const OBSERVATION_RULES_ERROR = "Observation redaction rules are invalid or unreadable";

const pendingRules = new Map<string, Promise<string[]>>();

export function observationLiterals(): Promise<string[]> {
  const path = process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
  if (path === undefined) return Promise.resolve([]);
  const pending = pendingRules.get(path);
  if (pending) return pending;
  const load = loadObservationLiterals(path).finally(() => pendingRules.delete(path));
  pendingRules.set(path, load);
  return load;
}

async function loadObservationLiterals(path: string): Promise<string[]> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error();
      const buffer = Buffer.alloc(RULES_LIMIT + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > RULES_LIMIT) throw new Error();
      const rules: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
      if (!Array.isArray(rules) || rules.length > 128 || rules.some((rule) => typeof rule !== "string" || rule.length === 0)) throw new Error();
      return rules;
    } finally {
      await file.close();
    }
  } catch {
    throw new Error(OBSERVATION_RULES_ERROR);
  }
}

function isEncodedImage(value: string): boolean {
  const match = value.startsWith("data:image/")
    ? /^data:image\/(?:png|apng|jpeg|jpg|gif|webp);base64,([\s\S]*)$/i.exec(value)
    : null;
  if (value.startsWith("data:image/") && !match) return false;
  const encoded = (match ? match[1] : value).replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) return false;
  const unpadded = encoded.replace(/=+$/, "");
  if (unpadded.length % 4 === 1 || (encoded.length !== unpadded.length &&
      (encoded.length % 4 !== 0 || encoded.length - unpadded.length !== (4 - unpadded.length % 4) % 4))) return false;
  const bytes = Buffer.from(encoded, "base64");
  return (bytes.length >= 20 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(-8, -4).toString() === "IEND") ||
    (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) ||
    (bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()) && bytes.at(-1) === 0x3b) ||
    (bytes.length >= 12 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length);
}

export function redactObservationLiterals(value: unknown, rules: string[]): unknown {
  if (rules.length === 0) return value;
  if (typeof value === "string") {
    if ((value.startsWith("data:image/") || value.startsWith("iVBORw0KGgo") || value.startsWith("/9j/")) && isEncodedImage(value)) return value;
    const masked = new Uint8Array(value.length);
    for (const rule of rules) {
      let index = value.indexOf(rule);
      let coveredThrough = 0;
      while (index !== -1) {
        const end = index + rule.length;
        masked.fill(1, Math.max(index, coveredThrough), end);
        coveredThrough = end;
        index = value.indexOf(rule, index + 1);
      }
    }
    const replacement = rules.some((rule) => "[REDACTED]".includes(rule)) ? "" : "[REDACTED]";
    let result = "";
    let start = 0;
    for (let i = 0; i < masked.length; i++) {
      if (masked[i] && (i === 0 || !masked[i - 1])) {
        result += value.slice(start, i) + replacement;
      } else if (!masked[i] && i > 0 && masked[i - 1]) {
        start = i;
      }
    }
    return masked.at(-1) ? result : result + value.slice(start);
  }
  if (Array.isArray(value)) return value.map((item) => redactObservationLiterals(item, rules));
  if (value !== null && typeof value === "object") {
    const entries: Array<[string, unknown]> = [];
    const used = new Set<string>();
    let code = 0xe000;
    while (rules.some((rule) => rule.includes(String.fromCharCode(code)))) code++;
    const suffix = String.fromCharCode(code);
    for (const [key, item] of Object.entries(value)) {
      let redactedKey = redactObservationLiterals(key, rules) as string;
      while (used.has(redactedKey)) redactedKey += suffix;
      used.add(redactedKey);
      entries.push([redactedKey, redactObservationLiterals(item, rules)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

const PRIVATE_TAG_RE = /<private>[\s\S]*?(?:<\\*\/private>|$)/gi;

const SECRET_PATTERN_SOURCES = [
  /\\*["'][\w-]*(?:api[_-]?key|secret|password|passwd|pwd)\\*["']\s*[=:]\s*\\*["'][^"'\\]+\\*["']/gi,
  /(?:\\*["'][\w-]*(?:api[_-]?key|secret|token|password|credential|auth)\\*["']|(?:api[_-]?key|secret|token|password|credential|auth))\s*[=:]\s*\\*["']?[A-Za-z0-9_\-/.+]{20,}\\*["']?/gi,
  /(?:\\*["'][\w-]*(?:api[_-]?key|secret|password|passwd|pwd)\\*["']|(?:api[_-]?key|secret|password|passwd|pwd))\s*[=:]\s*\\*["']?(?!(?:true|false|null)\b)[^\s"'\\]+\\*["']?/gi,
  /(?:api[_-]?key|secret|token|password|credential|auth)[\s]*[=:]\s*["']?[A-Za-z0-9_\-/.+]{20,}["']?/gi,
  /(?:api[_-]?key|secret|password|passwd|pwd)[\s]*[=:]\s*["']?[^\s"']+["']?/gi,
  /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi,
  /(?<![A-Za-z0-9])sk-proj-[A-Za-z0-9\-_]{20,}/g,
  /(?<![A-Za-z0-9])(?:sk|pk|rk|ak)-[A-Za-z0-9][A-Za-z0-9\-_]{19,}/g,
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9\-_]{20,}/g,
  /gh[pus]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /xoxb-[A-Za-z0-9\-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[A-Za-z0-9\-_]{35}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /npm_[A-Za-z0-9]{36}/g,
  /glpat-[A-Za-z0-9\-_]{20,}/g,
  /dop_v1_[A-Za-z0-9]{64}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const URL_CREDENTIAL_RE = /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(@)/gi;

export function stripPrivateData(input: string): string {
  let result = input.replace(PRIVATE_TAG_RE, "[REDACTED]");
  for (const source of SECRET_PATTERN_SOURCES) {
    const pattern = new RegExp(source.source, source.flags);
    result = result.replace(pattern, "[REDACTED_SECRET]");
  }
  return result.replace(URL_CREDENTIAL_RE, "$1[REDACTED_SECRET]$2");
}

const SECRET_KEY_RE = /(?:api[_-]?key|secret|token|password|passwd|credentials?|auth|authorization|private[_-]?key)$/i;

export function stripPrivateDataDeep(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return key !== undefined && value !== "" && SECRET_KEY_RE.test(key)
      ? "[REDACTED_SECRET]"
      : stripPrivateData(value);
  }
  if (Array.isArray(value)) return value.map((item) => stripPrivateDataDeep(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [stripPrivateData(k), stripPrivateDataDeep(v, k)]),
    );
  }
  return value;
}

// Every function that persists Agent-supplied free text scrubs it first,
// so a pasted token never lands in the store whichever surface wrote it.
export function scrubFields<T extends object>(data: T, ...fields: (keyof T)[]): T {
  const out = { ...data };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === "string") {
      out[field] = stripPrivateData(value) as T[keyof T];
    }
  }
  return out;
}

export function registerPrivacyFunction(sdk: ISdk): void {
  sdk.registerFunction("mem::privacy", 
    async (data: { input?: unknown } | undefined) => {
      if (!data || typeof data.input !== "string") {
        return { output: "", error: "invalid input: expected string field 'input'" };
      }
      return { output: stripPrivateData(data.input) };
    },
  );
}
