import { describe, it, expect } from "vitest";
import { stripPrivateData, stripPrivateDataDeep } from "../src/functions/privacy.js";

describe("stripPrivateData scrubber boundaries", () => {
  it.each([
    "possiblyneal/disk-full-retry-queue-impl",
    "task-runner-that-does-something-long",
  ])("leaves the compound word %s intact", (word) => {
    expect(stripPrivateData(`branch ${word} ok`)).toBe(`branch ${word} ok`);
  });

  it("still redacts a real sk- key", () => {
    expect(stripPrivateData("key sk-abcdefghijklmnopqrstuv end")).toBe(
      "key [REDACTED_SECRET] end",
    );
  });

  it("redacts a PEM private-key block whole", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc123\n-----END RSA PRIVATE KEY-----";
    expect(stripPrivateData(`before\n${pem}\nafter`)).toBe(
      "before\n[REDACTED_SECRET]\nafter",
    );
  });

  it("redacts only the password in URL credentials", () => {
    expect(stripPrivateData("curl https://user:hunter2@host/x")).toBe(
      "curl https://user:[REDACTED_SECRET]@host/x",
    );
  });
});

describe("stripPrivateData", () => {
  it("strips private tags", () => {
    expect(stripPrivateData("hello <private>secret</private> world")).toBe(
      "hello [REDACTED] world",
    );
  });

  it("strips private tags case-insensitive", () => {
    expect(stripPrivateData("<Private>data</Private>")).toBe("[REDACTED]");
  });

  it("strips API keys", () => {
    expect(stripPrivateData("api_key=sk-ant-1234567890abcdefghij")).toBe(
      "[REDACTED_SECRET]",
    );
  });

  it("strips GitHub PATs", () => {
    expect(
      stripPrivateData("token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh"),
    ).toBe("[REDACTED_SECRET]");
  });

  it("strips standalone GitHub PATs", () => {
    expect(
      stripPrivateData("found ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij here"),
    ).toBe("found [REDACTED_SECRET] here");
  });

  it("strips Slack tokens", () => {
    expect(stripPrivateData("xoxb-123456-789012-abcdef")).toBe(
      "[REDACTED_SECRET]",
    );
  });

  it("strips AWS access keys", () => {
    expect(stripPrivateData("key=AKIAIOSFODNN7EXAMPLE")).toBe(
      "key=[REDACTED_SECRET]",
    );
  });

  it("strips JWT tokens", () => {
    expect(
      stripPrivateData(
        "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpM",
      ),
    ).toBe("[REDACTED_SECRET]");
  });

  it("strips sk- prefixed keys", () => {
    expect(stripPrivateData("sk-1234567890abcdefghijklmnopqr")).toBe(
      "[REDACTED_SECRET]",
    );
  });

  it("strips OpenAI project keys", () => {
    expect(
      stripPrivateData("sk-proj-1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"),
    ).toBe("[REDACTED_SECRET]");
  });

  it("strips GitHub fine-grained service tokens", () => {
    expect(
      stripPrivateData("ghs_1234567890abcdefghijklmnopqrstuvwxyzAB"),
    ).toBe("[REDACTED_SECRET]");
  });

  it("strips bearer tokens", () => {
    expect(
      stripPrivateData(
        "Authorization: Bearer sk-proj-1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
      ),
    ).toBe("Authorization: [REDACTED_SECRET]");
  });

  it("handles multiple secrets in one string", () => {
    const input =
      "sk-abcdefghijklmnopqrstuv and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const result = stripPrivateData(input);
    expect(result).not.toContain("sk-");
    expect(result).not.toContain("ghp_");
  });

  it("strips short labelled passwords and keys", () => {
    expect(stripPrivateData("password=hunter2")).toBe("[REDACTED_SECRET]");
    expect(stripPrivateData("api_key=short")).toBe("[REDACTED_SECRET]");
    expect(stripPrivateData("db api_key: abc123 ok")).toBe("db [REDACTED_SECRET] ok");
  });

  it("does not strip short unlabelled strings", () => {
    expect(stripPrivateData("short=value")).toBe("short=value");
  });

  it("returns empty string unchanged", () => {
    expect(stripPrivateData("")).toBe("");
  });

  it("handles no secrets gracefully", () => {
    expect(stripPrivateData("normal text without secrets")).toBe(
      "normal text without secrets",
    );
  });

  it("works correctly on consecutive calls (no regex statefulness)", () => {
    const input = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZabc";
    expect(stripPrivateData(input)).toBe("[REDACTED_SECRET]");
    expect(stripPrivateData(input)).toBe("[REDACTED_SECRET]");
    expect(stripPrivateData(input)).toBe("[REDACTED_SECRET]");
  });
});

describe("JSON-shaped secrets (#435)", () => {
  const HEX = "0123456789abcdef0123456789abcdef0123456789abcdef";

  it("redacts a secret under a quoted key in JSON text", () => {
    const out = stripPrivateData(`{ "authToken": "${HEX}", "port": 6768 }`);
    expect(out).not.toContain(HEX);
    expect(out).toContain('"port": 6768');
  });

  it("redacts a secret under an escaped quoted key in double-encoded JSON", () => {
    const out = stripPrivateData(`{\\"token\\": \\"${HEX}\\"}`);
    expect(out).not.toContain(HEX);
  });

  it("redacts a short password under a quoted key", () => {
    expect(stripPrivateData(`{"password": "hunter2"}`)).not.toContain("hunter2");
  });

  it("continues to redact boolean-like password strings and unquoted assignments", () => {
    expect(stripPrivateData('{"password":"true"}')).not.toContain('true');
    expect(stripPrivateData('password=true')).not.toContain('true');
  });

  it("leaves a token count alone", () => {
    expect(stripPrivateData(`{"max_tokens": 4096}`)).toBe(`{"max_tokens": 4096}`);
  });

  it("redacts an unclosed private block to the end of the text", () => {
    expect(stripPrivateData("keep <private>cut by a hook before the close")).toBe(
      "keep [REDACTED]",
    );
  });

  it("ends a private block at an escaped close tag", () => {
    const src = String.raw`const RE = /<private>[\s\S]*?<\/private>/gi; const keep = 1;`;
    expect(stripPrivateData(src)).toContain("const keep = 1;");
  });

  it.each([
    String.raw`docker run -v "$PWD":/src golang`,
    String.raw`if [[ "$PWD" == "$work" ]]; then`,
    "ls: cannot access '/srv/nkos/admin-password': No such file or directory",
    String.raw`{"has_secret":true,"redirects":[]}`,
  ])("leaves text that only looks like a quoted key: %s", (text) => {
    expect(stripPrivateData(text)).toBe(text);
  });
});

describe("stripPrivateDataDeep", () => {
  it("redacts string values under secret-named keys at any depth", () => {
    const out = stripPrivateDataDeep({
      tool_input: { headers: { Authorization: "abc", "x-api-key": "k1" }, accessToken: "t" },
      list: [{ client_secret: "s" }],
    });
    expect(out).toEqual({
      tool_input: {
        headers: { Authorization: "[REDACTED_SECRET]", "x-api-key": "[REDACTED_SECRET]" },
        accessToken: "[REDACTED_SECRET]",
      },
      list: [{ client_secret: "[REDACTED_SECRET]" }],
    });
  });

  it("keeps shape, numbers, booleans, nulls and unrelated keys", () => {
    const input = { max_tokens: 4096, has_secret: true, token: "", n: null, file_path: "/a/b" };
    expect(stripPrivateDataDeep(input)).toEqual(input);
  });

  it("scrubs secret assignments in object keys as well as values", () => {
    expect(JSON.stringify(stripPrivateDataDeep({ "password=abc123": "value" }))).not.toContain("abc123");
  });

  it("scrubs secrets inside ordinary string values", () => {
    expect(stripPrivateDataDeep({ command: "export API_KEY=abc123" })).toEqual({
      command: "export [REDACTED_SECRET]",
    });
  });
});
