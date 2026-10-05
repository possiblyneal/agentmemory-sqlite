import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { postJsonUntimed } from "../src/cli/post-untimed.js";

let server: Server | undefined;

afterEach(() => server?.close());

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) =>
    server!.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/import`),
    ),
  );
}

describe("postJsonUntimed", () => {
  it("sends the JSON body and headers and returns the delayed reply", async () => {
    const url = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () =>
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ got: JSON.parse(body), auth: req.headers["authorization"] }));
        }, 50),
      );
    });

    const res = await postJsonUntimed(url, { authorization: "Bearer s" }, JSON.stringify({ path: "/x" }));

    expect(res.ok).toBe(true);
    expect(JSON.parse(res.text)).toEqual({ got: { path: "/x" }, auth: "Bearer s" });
  });

  it("reports a non-2xx status without throwing", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(401);
      res.end('{"error":"unauthorized"}');
    });

    const res = await postJsonUntimed(url, {}, "{}");

    expect(res).toEqual({ status: 401, ok: false, text: '{"error":"unauthorized"}' });
  });

  it("rejects when the daemon is unreachable", async () => {
    await expect(postJsonUntimed("http://127.0.0.1:1/import", {}, "{}")).rejects.toThrow();
  });
});
