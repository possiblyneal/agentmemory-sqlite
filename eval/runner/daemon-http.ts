// One request to a daemon's REST API, timed, with the error body in the throw.
export async function daemonCall<T>(
  baseUrl: string,
  path: string,
  opts: { body?: unknown; secret?: string } = {},
): Promise<{ body: T; ms: number }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.secret) headers.Authorization = `Bearer ${opts.secret}`;
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/agentmemory/${path}`, {
    method: opts.body === undefined ? "GET" : "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${text.slice(0, 200)}`);
  return { body: JSON.parse(text) as T, ms };
}
