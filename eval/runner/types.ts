export interface EvalObservation {
  tool: string;
  file?: string;
  pattern?: string;
  output: string;
}

export interface Session {
  id: string;
  project?: string;
  timestamp?: string;
  content?: string;
  observations?: EvalObservation[];
}

export type QuestionPath = "search" | "pre-tool-use" | "session-start";

export interface Question {
  id: string;
  type: string;
  path?: QuestionPath;
  project?: string;
  question?: string;
  tool?: string;
  file?: string;
  pattern?: string;
  answer?: string;
  goldSessionIds: string[];
  haystack: Session[];
}

export interface RankedDoc {
  sessionId: string;
  score: number;
}

export interface QueryResult {
  ranked: RankedDoc[];
  chars?: number;
}

export interface Adapter<State = unknown> {
  name: string;
  paths: QuestionPath[];
  init(sessions: Session[], config?: Record<string, unknown>): Promise<State>;
  query(q: Question, state: State, k: number): Promise<QueryResult>;
  teardown?(state: State): Promise<void>;
}

export interface ScoreRow {
  questionId: string;
  questionType: string;
  path: QuestionPath;
  adapter: string;
  k: number;
  returned: number;
  returnedIds: string[];
  answerable: boolean;
  precision: number;
  recall: number | null;
  hit: boolean;
  topGoldRank: number | null;
  chars: number | null;
  latencyMs: number;
}

export function questionPath(q: Pick<Question, "path">): QuestionPath {
  return q.path ?? "search";
}

export function sessionText(s: Session): string {
  const parts = s.content ? [s.content] : [];
  for (const o of s.observations ?? []) {
    parts.push([o.file, o.pattern, o.output].filter(Boolean).join(" "));
  }
  return parts.join("\n");
}
