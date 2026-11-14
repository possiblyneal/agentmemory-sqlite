export const EXTERNAL_SOURCES = ["commits", "prs", "issues"] as const;
export type ExternalSource = (typeof EXTERNAL_SOURCES)[number];

// One commit, pull request or issue of a repository, as text a connector would
// post. `at` is when the text was final: a commit's committer date, a closed
// item's closing time, an open one's last update, so no probe before `at` sees it.
export interface ExternalItem {
  source: ExternalSource;
  project: string;
  id: string;
  at: string;
  text: string;
  files: string[];
}

export interface ExternalCorpus {
  builtAt: string;
  items: ExternalItem[];
}

// The 8 arms of #396: none, each source alone, each pair, all three.
export const EXTERNAL_ARMS: string[] = [
  "none",
  "commits",
  "prs",
  "issues",
  "commits+prs",
  "commits+issues",
  "prs+issues",
  "commits+prs+issues",
];

export function parseExternalArm(arm: string): ExternalSource[] {
  if (!EXTERNAL_ARMS.includes(arm)) {
    throw new Error(`--external-arm must be one of ${EXTERNAL_ARMS.join(", ")}, got "${arm}"`);
  }
  return arm === "none" ? [] : (arm.split("+") as ExternalSource[]);
}

// What the daemon holds for a Session of `project` starting at `before`:
// every item of the arm's sources, of that project, final before it, oldest first.
export function itemsBefore(
  corpus: ExternalCorpus,
  arm: ExternalSource[],
  project: string,
  before: string,
): ExternalItem[] {
  const cutoff = Date.parse(before);
  return corpus.items
    .filter((i) => i.project === project && arm.includes(i.source) && Date.parse(i.at) < cutoff)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}

export function externalSessionId(project: string, source: ExternalSource): string {
  return `external-${source}-${project}`;
}
