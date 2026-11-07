import type { Checkpoint } from "./replay-checkpoints.js";

export interface ArmArgs {
  ref: string;
  label: string;
  replayArgs: string[];
}

// The arm owns where each pass writes and which pass it is.
const OWNED_FLAGS = ["--out", "--save-checkpoints", "--from-checkpoints", "--resume"];

export function parseArmArgs(argv: string[]): ArmArgs {
  let ref: string | undefined;
  let label: string | undefined;
  const replayArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.split("=")[0];
    if (name === "--ref" || name === "--label") {
      const value = arg.includes("=") ? arg.slice(name.length + 1) : argv[++i];
      if (name === "--ref") ref = value;
      else label = value;
    } else if (OWNED_FLAGS.includes(name)) {
      throw new Error(`${name} is set by eval:arm; drop it`);
    } else {
      replayArgs.push(arg);
    }
  }
  if (!ref) throw new Error("--ref <git ref> is required");
  if (!label) throw new Error("--label <name> is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) throw new Error(`label ${label} must be a plain directory name`);
  return { ref, label, replayArgs };
}

// The probe reads stores the save pass already compressed and summarized.
export function probeArgs(replayArgs: string[]): string[] {
  return replayArgs.filter((a) => a !== "--llm" && a !== "--llm-summary");
}

// The save pass logs `[k/N] … failed=F` per Session; F > 0 taints the stores
// from that Session on. Returns the zero-based index of that Session.
export function failedSessionIndex(line: string): number | undefined {
  const m = /^\[(\d+)\/\d+\] [0-9a-f]+ .*failed=([1-9]\d*)/.exec(line);
  return m ? Number(m[1]) - 1 : undefined;
}

// The store saved at index i predates Session i's import, so a checkpoint at
// or before the failed Session is clean and any later one is not.
export function resumePlan(manifest: Checkpoint[], failedIndex: number): { keep: Checkpoint[]; remove: string[] } {
  const clean = (c: Checkpoint) => Number.parseInt(c.file, 10) <= failedIndex;
  return { keep: manifest.filter(clean), remove: manifest.filter((c) => !clean(c)).map((c) => c.file) };
}
