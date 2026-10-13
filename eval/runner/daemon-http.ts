import { request } from "node:http";

// One request to a daemon's REST API, timed, with the error body in the throw.
// node:http, not fetch: fetch gives up after 300 s without response headers
// whatever its signal allows, and a long Session's summarize runs past that.
export async function daemonCall<T>(
  baseUrl: string,
  path: string,
  opts: { body?: unknown; secret?: string; timeoutMs?: number } = {},
): Promise<{ body: T; ms: number }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.secret) headers.Authorization = `Bearer ${opts.secret}`;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const t0 = performance.now();
  const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(
      `${baseUrl}/agentmemory/${path}`,
      {
        method: payload === undefined ? "GET" : "POST",
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
  const ms = performance.now() - t0;
  if (status < 200 || status >= 300) throw new Error(`${path} failed: ${status} ${text.slice(0, 200)}`);
  return { body: JSON.parse(text) as T, ms };
}
