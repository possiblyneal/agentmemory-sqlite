import { createHash } from "node:crypto";

export interface Selection {
  sessions: number;
  fingerprint: string;
}

export function selectionOf(sessionIds: Iterable<string>): Selection {
  const ids = [...sessionIds].sort();
  const fingerprint = createHash("sha256").update(JSON.stringify(ids)).digest("hex").slice(0, 16);
  return { sessions: ids.length, fingerprint };
}

const describeSelection = (s: Selection | undefined) => (s ? `${s.sessions} Sessions, ${s.fingerprint}` : "no selection recorded");

export function selectionWarning(before: Selection | undefined, after: Selection | undefined): string | undefined {
  if (before && after && before.fingerprint === after.fingerprint) return undefined;
  return (
    `replay scored different corpora (${describeSelection(before)} vs ${describeSelection(after)}); ` +
    "the numbers are not comparable. Freeze the transcripts and pass --root (eval/README.md)."
  );
}
