import { logger } from "../logger.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type GuardRejection = { status: 403 | 415; error: string };

type HeaderValue = string | string[] | undefined;

export function readAllowedViewerHosts(): string[] {
  return (process.env.VIEWER_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end >= 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.indexOf(":");
  return colon >= 0 ? h.slice(0, colon) : h;
}

function matchesAllowedEntry(hostHeader: string, entries: string[]): boolean {
  const full = hostHeader.trim().toLowerCase();
  const name = hostnameOf(full);
  return entries.some((e) => e === full || e === name);
}

function originAllowed(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (LOOPBACK_HOSTNAMES.has(parsed.hostname)) return true;
  return matchesAllowedEntry(parsed.host, readAllowedViewerHosts());
}

function hostAllowed(hostHeader: HeaderValue, bindHost?: string): boolean {
  if (typeof hostHeader !== "string" || !hostHeader.trim()) return false;
  const name = hostnameOf(hostHeader);
  if (LOOPBACK_HOSTNAMES.has(name)) return true;
  if (bindHost) {
    const bind = bindHost.trim().toLowerCase();
    if (name === bind || name === `[${bind}]`) return true;
  }
  return matchesAllowedEntry(hostHeader, readAllowedViewerHosts());
}

function isJson(contentType: HeaderValue): boolean {
  if (typeof contentType !== "string") return false;
  return contentType.split(";")[0].trim().toLowerCase() === "application/json";
}

export type GuardInput = {
  method: string;
  headers: Record<string, HeaderValue>;
  /** Check the Host header too; the viewer does its own Host check. */
  checkHost?: { bindHost?: string };
};

export function guardRequest(input: GuardInput): GuardRejection | null {
  const { headers } = input;
  if (input.checkHost && !hostAllowed(headers.host, input.checkHost.bindHost)) {
    return { status: 403, error: "forbidden host" };
  }
  if (SAFE_METHODS.has(input.method.toUpperCase())) return null;
  const origin = headers.origin;
  if (origin !== undefined && !(typeof origin === "string" && originAllowed(origin))) {
    return { status: 403, error: "forbidden origin" };
  }
  if (!isJson(headers["content-type"])) {
    return { status: 415, error: "Content-Type must be application/json" };
  }
  return null;
}

const MAX_LOGGED_SOURCES = 256;
const loggedSources = new Set<string>();

export function logRejection(
  surface: "rest" | "viewer",
  req: { method?: string; socket: { remoteAddress?: string } },
  rejection: GuardRejection,
): void {
  const key = `${surface}|${req.socket.remoteAddress ?? "unknown"}|${rejection.error}`;
  if (loggedSources.has(key) || loggedSources.size >= MAX_LOGGED_SOURCES) return;
  loggedSources.add(key);
  logger.warn("request rejected", {
    surface,
    source: req.socket.remoteAddress,
    method: req.method,
    reason: rejection.error,
  });
}
