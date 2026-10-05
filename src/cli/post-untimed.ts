import { request } from "node:http";

export type UntimedResponse = { status: number; ok: boolean; text: string };

/**
 * POSTs JSON and waits for the reply however long it takes. Global `fetch`
 * gives up after undici's 300 s headers timeout, which a long-running import
 * that only answers once it finishes can exceed.
 */
export function postJsonUntimed(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<UntimedResponse> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}
