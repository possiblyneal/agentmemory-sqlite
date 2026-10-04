import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { writeFileAtomicNoSymlink } from "../src/utils/atomic-write.js";

describe("writeFileAtomicNoSymlink", () => {
  let dir: string;
  beforeEach(() => {
    mkdirSync("tmp", { recursive: true });
    dir = mkdtempSync(join("tmp", "atomic-write-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a new file and leaves no temp files", () => {
    const target = join(dir, "a.txt");
    writeFileAtomicNoSymlink(target, "hello");
    expect(readFileSync(target, "utf-8")).toBe("hello");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });

  it("replaces an existing file", () => {
    const target = join(dir, "a.txt");
    writeFileSync(target, "old");
    writeFileAtomicNoSymlink(target, "new");
    expect(readFileSync(target, "utf-8")).toBe("new");
  });

  it("refuses a symlinked target and leaves the link destination untouched", () => {
    const real = join(dir, "real.txt");
    const link = join(dir, "link.txt");
    writeFileSync(real, "keep");
    symlinkSync(real, link);
    expect(() => writeFileAtomicNoSymlink(link, "evil")).toThrow(/symlink/);
    expect(readFileSync(real, "utf-8")).toBe("keep");
    expect(readdirSync(dir).sort()).toEqual(["link.txt", "real.txt"]);
  });

  it("refuses a dangling symlink", () => {
    const link = join(dir, "link.txt");
    symlinkSync(join(dir, "missing.txt"), link);
    expect(() => writeFileAtomicNoSymlink(link, "x")).toThrow(/symlink/);
  });
});
