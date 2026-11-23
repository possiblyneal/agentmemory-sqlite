import type { CompressedObservation } from "../types.js";
import { parseTimestamp, withinDateRange, type DateRange } from "../functions/date-range.js";
import { stem } from "./stemmer.js";
import { getSynonyms } from "./synonyms.js";
import { STOP_WORDS } from "./stopwords.js";
import { dateTermsForQuery, dateTermsForTimestamp } from "./date-terms.js";
import { segmentCjk, hasCjk, cjkBigrams } from "./cjk-segmenter.js";
import { yieldToEventLoop } from "../utils/event-loop.js";

interface IndexEntry {
  obsId: string;
  sessionId: string;
  termCount: number;
  timestamp: string;
  files: string[];
  layer?: IndexLayer;
  postingOrder: number;
}

export type IndexLayer = "memory" | "observation";

export const SEARCH_LAYERS = ["memory", "observation", "all"] as const;
export type SearchLayer = (typeof SEARCH_LAYERS)[number];

export function isSearchLayer(value: unknown): value is SearchLayer {
  return SEARCH_LAYERS.includes(value as SearchLayer);
}

const TITLE_WEIGHT = 3;
const SUBTITLE_WEIGHT = 2;
const MAX_QUERY_TERMS = 25;
const MAX_QUERY_DATE_TERMS = 5;
const EDGE_PUNCTUATION = /^[/.\\_-]+|[/.\\_-]+$/g;
// Prefix expansion looks terms up by their first characters, so the
// vocabulary is never sorted: re-sorting ~477k terms after every write held
// the event loop for seconds on a live daemon (#371).
const BUCKET_CHARS = 2;
const SEARCH_SLICE_MS = 10;
// A common term's posting list, or a short prefix's expansion, is tens of
// thousands of documents scored in one loop; the search offers to yield after
// this many, so one term cannot hold the event loop for hundreds of ms.
const POSTINGS_PER_STEP = 2048;

export type SearchHit = { obsId: string; sessionId: string; score: number };

export class SearchIndex {
  private entries: Map<string, IndexEntry> = new Map();
  private invertedIndex: Map<string, Set<string>> = new Map();
  private docTermCounts: Map<string, Map<string, number>> = new Map();
  // Most date postings agree with the bounded parser; keep only the differences
  // so unbounded queries retain their original postings and scoring order.
  private boundedDateDeltas = new Map<string, { added: Set<string>; omitted: Set<string> }>();
  private nextPostingOrder = 0;
  private totalDocLength = 0;
  private termsByLead: Map<string, Set<string>> = new Map();

  private readonly k1 = 1.2;
  private readonly b = 0.75;

  add(obs: CompressedObservation, layer: IndexLayer = "observation"): void {
    // Re-adding an existing id must not double-count its length.
    // `entries.set` below overwrites the entry, but `totalDocLength +=`
    // is unconditional — so a re-add inflates avgDocLen for EVERY
    // document, silently skewing the b=0.75 length normalisation
    // corpus-wide. Remove first; remove() is a no-op for unknown ids.
    if (this.entries.has(obs.id)) this.remove(obs.id);

    const termFreq = new Map<string, number>();
    let termCount = 0;

    for (const { terms, weight } of this.extractFields(obs)) {
      for (const term of terms) {
        termFreq.set(term, (termFreq.get(term) || 0) + weight);
        termCount++;
      }
    }

    const localDates = dateTermsForTimestamp(obs.timestamp);
    for (const term of localDates) termFreq.set(term, 1);
    this.updateBoundedDates(obs.id, obs.timestamp, localDates, true);

    this.entries.set(obs.id, {
      obsId: obs.id,
      sessionId: obs.sessionId,
      termCount,
      timestamp: obs.timestamp,
      files: obs.files ?? [],
      layer,
      postingOrder: this.nextPostingOrder++,
    });
    this.docTermCounts.set(obs.id, termFreq);
    this.totalDocLength += termCount;

    for (const term of termFreq.keys()) {
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, new Set());
        this.addToLead(term);
      }
      this.invertedIndex.get(term)!.add(obs.id);
    }
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  // Indexed document ids, for the importer's corpus delta.
  ids(): IterableIterator<string> {
    return this.entries.keys();
  }

  // Indexed documents from the given Sessions that name at least one file,
  // so a file lookup need not read every Observation of those Sessions.
  withFilesIn(
    sessionIds: ReadonlySet<string>,
  ): Array<{ obsId: string; sessionId: string; files: string[] }> {
    const out: Array<{ obsId: string; sessionId: string; files: string[] }> = [];
    for (const entry of this.entries.values()) {
      if (entry.files?.length && sessionIds.has(entry.sessionId)) {
        out.push({ obsId: entry.obsId, sessionId: entry.sessionId, files: entry.files });
      }
    }
    return out;
  }

  private updateBoundedDates(id: string, timestamp: string, localDates: string[], adding: boolean): void {
    const boundedDates = timestamp ? dateTermsForTimestamp(parseTimestamp(timestamp)) : [];
    for (const term of localDates) {
      if (!boundedDates.includes(term)) this.updateDateDelta(term, id, "omitted", adding);
    }
    for (const term of boundedDates) {
      if (!localDates.includes(term)) this.updateDateDelta(term, id, "added", adding);
    }
  }

  private updateDateDelta(term: string, id: string, side: "added" | "omitted", adding: boolean): void {
    let delta = this.boundedDateDeltas.get(term);
    if (adding) {
      if (!delta) {
        delta = { added: new Set(), omitted: new Set() };
        this.boundedDateDeltas.set(term, delta);
      }
      delta[side].add(id);
    } else if (delta) {
      delta[side].delete(id);
      if (!delta.added.size && !delta.omitted.size) this.boundedDateDeltas.delete(term);
    }
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    const termFreq = this.docTermCounts.get(id);
    if (termFreq) {
      const localDates = [];
      for (const term of termFreq.keys()) {
        if (term.startsWith("@")) localDates.push(term);
        const postingList = this.invertedIndex.get(term);
        if (postingList) {
          postingList.delete(id);
          if (postingList.size === 0) {
            this.invertedIndex.delete(term);
            this.removeFromLead(term);
          }
        }
      }
      this.updateBoundedDates(id, entry.timestamp, localDates, false);
      this.docTermCounts.delete(id);
    }

    this.totalDocLength = Math.max(0, this.totalDocLength - entry.termCount);
    this.entries.delete(id);
  }

  search(query: string, limit = 20, layer?: IndexLayer): SearchHit[] {
    const steps = this.scoreTerms(query);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return this.ranked(step.value, limit, layer);
  }

  searchEligible(query: string, limit: number, eligible: (id: string) => boolean): { hits: SearchHit[]; maxScore: number } {
    const steps = this.scoreTerms(query);
    let step = steps.next();
    while (!step.done) step = steps.next();
    let maxScore = 0;
    for (const score of step.value.values()) maxScore = Math.max(maxScore, score);
    return { hits: this.ranked(step.value, limit, undefined, eligible), maxScore };
  }

  // Ranks as search() does, but hands the event loop back between query terms
  // once `sliceMs` of scoring has run, so a search over a large store does not
  // hold /livez and the hooks behind it (#371).
  async searchCooperatively(
    query: string,
    limit = 20,
    layer?: IndexLayer,
    sliceMs = SEARCH_SLICE_MS,
    range?: DateRange,
  ): Promise<SearchHit[]> {
    const bounded = range?.after !== undefined || range?.before !== undefined;
    const steps = this.scoreTerms(query, bounded);
    let sliceStart = performance.now();
    let step = steps.next();
    while (!step.done) {
      if (performance.now() - sliceStart >= sliceMs) {
        await yieldToEventLoop();
        sliceStart = performance.now();
      }
      step = steps.next();
    }
    return this.ranked(step.value, limit, layer, range ? (id) => withinDateRange(this.entries.get(id)?.timestamp, range) : undefined);
  }

  // A document removed while a cooperative search yielded is left out. Only
  // the head is kept: sorting every scored document held the event loop for
  // up to 200 ms on a 99k-document index, to throw all but `limit` away. Ties
  // rank in scoring order, as a stable sort of the full list would.
  private ranked(scores: Map<string, number>, limit: number, layer?: IndexLayer, eligible?: (id: string) => boolean): SearchHit[] {
    const head: SearchHit[] = [];
    for (const [obsId, score] of scores) {
      if (limit <= 0 || (eligible && !eligible(obsId)) || (head.length === limit && !(score > head[limit - 1].score))) continue;
      const entry = this.entries.get(obsId);
      if (!entry || (layer && (entry.layer ?? "observation") !== layer)) continue;
      let at = head.length;
      while (at > 0 && head[at - 1].score < score) at--;
      head.splice(at, 0, { obsId, sessionId: entry.sessionId, score });
      if (head.length > limit) head.pop();
    }
    return head;
  }

  private *mergeDatePostings(base: Set<string>, added: Set<string>): Generator<string> {
    const baseIds = base.values();
    const addedIds = added.values();
    const order = (posting: ReturnType<typeof baseIds.next>) =>
      posting.done ? Infinity : (this.entries.get(posting.value)?.postingOrder ?? -1);
    let left = baseIds.next();
    let right = addedIds.next();
    let leftOrder = order(left);
    let rightOrder = order(right);
    while (!left.done || !right.done) {
      if (!left.done && leftOrder <= rightOrder) {
        yield left.value;
        left = baseIds.next();
        leftOrder = order(left);
      } else if (!right.done) {
        yield right.value;
        right = addedIds.next();
        rightOrder = order(right);
      }
    }
  }

  // Yields every POSTINGS_PER_STEP documents scored and after each query term.
  private *scoreTerms(query: string, bounded = false): Generator<void, Map<string, number>> {
    const scores = new Map<string, number>();
    const rawTerms = this.tokenize(query.toLowerCase(), STOP_WORDS);
    const dateTerms = dateTermsForQuery(query).slice(0, MAX_QUERY_DATE_TERMS);
    if (rawTerms.length === 0 && dateTerms.length === 0) return scores;

    const N = this.entries.size;
    if (N === 0) return scores;
    const avgDocLen = this.totalDocLength / N;

    const queryTerms: Array<{ term: string; weight: number }> = [];
    const seen = new Set<string>();
    for (const term of this.rarestIndexedTerms(rawTerms)) {
      if (!seen.has(term)) {
        seen.add(term);
        queryTerms.push({ term, weight: 1.0 });
      }
      for (const syn of getSynonyms(term)) {
        if (!seen.has(syn)) {
          seen.add(syn);
          queryTerms.push({ term: syn, weight: 0.7 });
        }
      }
    }

    for (const term of dateTerms) queryTerms.push({ term, weight: 1.0 });

    for (const { term, weight } of queryTerms) {
      const matchingDocs = this.invertedIndex.get(term);
      const boundedDate = bounded && term.startsWith("@");
      const delta = boundedDate ? this.boundedDateDeltas.get(term) : undefined;
      const df = (matchingDocs?.size ?? 0) + (delta?.added.size ?? 0) - (delta?.omitted.size ?? 0);
      if (df > 0) {
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const postings = matchingDocs && delta?.added.size
          ? this.mergeDatePostings(matchingDocs, delta.added)
          : (matchingDocs ?? delta!.added);
        // A replacement can reappear at the tail of either live iterator after a yield.
        const postingEnd = this.nextPostingOrder;
        let scored = 0;
        for (const obsId of postings) {
          if (++scored % POSTINGS_PER_STEP === 0) yield;
          const entry = this.entries.get(obsId);
          if (!entry || (boundedDate && entry.postingOrder >= postingEnd)) continue;
          const docTerms = this.docTermCounts.get(obsId);
          const liveDelta = boundedDate ? this.boundedDateDeltas.get(term) : undefined;
          if (liveDelta?.omitted.has(obsId)) continue;
          const tf = liveDelta?.added.has(obsId) ? 1 : docTerms?.get(term);
          if (!tf) continue;
          const docLen = entry.termCount;

          const numerator = tf * (this.k1 + 1);
          const denominator =
            tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
          const bm25Score = idf * (numerator / denominator) * weight;

          scores.set(obsId, (scores.get(obsId) || 0) + bm25Score);
        }
      }

      // Prefix expansion approximates ONE query term ("index" -> "indexes",
      // "indexing"), so the expansions must together contribute like one
      // term: take the best-matching sibling, never the sum. Summing is
      // unbounded — a document enumerating v1.0.0 ... v1.40.0 accumulates a
      // full BM25 contribution for each distinct sibling of the single query
      // token "v1". Measured on a 200-doc corpus: 1 sibling scores 3.63 and
      // 80 siblings score 110.01, against a ~22 ceiling for any single term
      // (idf_max * (k1+1)). That let version and tag lists outrank exact
      // matches, including curated memories. Max-combining is bounded by
      // construction and is the usual treatment for wildcard expansions
      // (dis_max / constant-score rewrite). AGENTMEMORY_PREFIX_MATCH=sum
      // restores the old additive behaviour.
      const prefixSum = process.env.AGENTMEMORY_PREFIX_MATCH === "sum";
      const prefixBest = new Map<string, number>();
      let prefixScored = 0;
      for (const indexTerm of this.termsExtending(term)) {
        // A term whose last document was removed while the search yielded.
        const obsIds = this.invertedIndex.get(indexTerm);
        if (!obsIds) continue;
        const prefixDf = obsIds.size;
        const prefixIdf =
          Math.log((N - prefixDf + 0.5) / (prefixDf + 0.5) + 1) * 0.5;
        for (const obsId of obsIds) {
          if (++prefixScored % POSTINGS_PER_STEP === 0) yield;
          const entry = this.entries.get(obsId);
          const tf = this.docTermCounts.get(obsId)?.get(indexTerm);
          if (!entry || !tf) continue;
          const docLen = entry.termCount;
          const numerator = tf * (this.k1 + 1);
          const denominator =
            tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
          const contribution = prefixIdf * (numerator / denominator) * weight;
          if (prefixSum) {
            scores.set(obsId, (scores.get(obsId) || 0) + contribution);
          } else {
            const best = prefixBest.get(obsId);
            if (best === undefined || contribution > best) {
              prefixBest.set(obsId, contribution);
            }
          }
        }
      }
      for (const [obsId, contribution] of prefixBest) {
        scores.set(obsId, (scores.get(obsId) || 0) + contribution);
      }
      yield;
    }
    return scores;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.invertedIndex.clear();
    this.docTermCounts.clear();
    this.boundedDateDeltas.clear();
    this.totalDocLength = 0;
    this.termsByLead.clear();
  }

  restoreFrom(other: SearchIndex): void {
    this.entries = new Map(
      Array.from(other.entries, ([id, entry]) => [id, { ...entry, postingOrder: this.nextPostingOrder++ }]),
    );
    this.invertedIndex = new Map(
      Array.from(other.invertedIndex.entries()).map(([k, v]) => [
        k,
        new Set(v),
      ]),
    );
    this.docTermCounts = new Map(
      Array.from(other.docTermCounts.entries()).map(([k, v]) => [
        k,
        new Map(v),
      ]),
    );
    this.boundedDateDeltas = new Map(
      Array.from(other.boundedDateDeltas, ([term, { added, omitted }]) => [
        term, { added: new Set(added), omitted: new Set(omitted) },
      ]),
    );
    this.totalDocLength = other.totalDocLength;
    this.termsByLead = new Map(
      Array.from(other.termsByLead.entries()).map(([k, v]) => [k, new Set(v)]),
    );
  }

  serialize(): string {
    const entries = Array.from(this.entries, ([id, { postingOrder: _postingOrder, ...entry }]) => [id, entry]);
    const inverted = Array.from(this.invertedIndex.entries()).map(
      ([term, ids]) => [term, Array.from(ids)] as [string, string[]],
    );
    const docTerms = Array.from(this.docTermCounts.entries()).map(
      ([id, counts]) =>
        [id, Array.from(counts.entries())] as [string, [string, number][]],
    );
    return JSON.stringify({
      v: 2,
      entries,
      inverted,
      docTerms,
      totalDocLength: this.totalDocLength,
    });
  }

  static deserialize(json: string): SearchIndex {
    try {
      const idx = new SearchIndex();
      const data = JSON.parse(json);
      if (!data?.entries || !data?.inverted || !data?.docTerms) return idx;
      for (const [key, val] of data.entries) {
        idx.entries.set(key, { ...val, postingOrder: idx.nextPostingOrder++ });
      }
      for (const [term, ids] of data.inverted) {
        idx.invertedIndex.set(term, new Set(ids));
        idx.addToLead(term);
      }
      for (const [id, counts] of data.docTerms) {
        const termFreq = new Map<string, number>(counts);
        idx.docTermCounts.set(id, termFreq);
        const entry = idx.entries.get(id);
        if (entry) idx.updateBoundedDates(id, entry.timestamp, [...termFreq.keys()].filter((term) => term.startsWith("@")), true);
      }
      const rawLen = Number(data.totalDocLength);
      idx.totalDocLength =
        Number.isFinite(rawLen) && rawLen >= 0 ? Math.floor(rawLen) : 0;
      return idx;
    } catch {
      return new SearchIndex();
    }
  }

  // A title or subtitle hit counts for more than a narrative hit, so a record
  // that names the subject outranks a long one that merely mentions it. The
  // weight scales term frequency only; document length stays the raw token
  // count so length normalisation is unchanged. A title that is just the start
  // of the record's own narrative (a prompt_submit title) adds no signal, so
  // it keeps weight 1.
  private extractFields(
    obs: CompressedObservation,
  ): Array<{ terms: string[]; weight: number }> {
    const field = (parts: string[], weight: number) => ({
      terms: this.tokenize(parts.join(" ").toLowerCase()),
      weight,
    });
    const collapse = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
    const title = collapse(obs.title).replace(/\u2026$/, "");
    const restatesNarrative =
      title.length > 0 && collapse(obs.narrative).startsWith(title);
    return [
      field([obs.title], restatesNarrative ? 1 : TITLE_WEIGHT),
      field([obs.subtitle || ""], SUBTITLE_WEIGHT),
      field(
        [
          obs.narrative,
          ...obs.facts,
          ...obs.concepts,
          ...obs.files,
          obs.type,
          // Full prompt text (prompt_submit records only): makes every word of
          // the user's prompt lexically searchable, not just the summary of it.
          obs.userPrompt || "",
        ],
        1,
      ),
    ];
  }

  // Search cost is the sum of each term's posting lists, so a pasted
  // prompt's common words ("the", "in", and every index term they prefix)
  // dominate it while adding almost no score. Keep the rarest terms, as
  // Lucene's MoreLikeThis does: a 4,000-char prompt took 1.7 s on a 54k-doc
  // index against the prompt hook's then 1.5 s budget. A term the index has never
  // seen sorts last: it scores nothing exact, and ranking it rarest let a
  // prompt's hashes and typos crowd out every term that matches.
  private rarestIndexedTerms(terms: string[]): string[] {
    const unique = [...new Set(terms)];
    if (unique.length <= MAX_QUERY_TERMS) return unique;
    const df = (t: string) => this.invertedIndex.get(t)?.size || Number.MAX_SAFE_INTEGER;
    return unique.sort((a, b) => df(a) - df(b)).slice(0, MAX_QUERY_TERMS);
  }

  private tokenize(text: string, skip?: ReadonlySet<string>): string[] {
    const cleaned = text.replace(/[^\p{L}\p{N}\s/.\\-_]/gu, " ");
    const out: string[] = [];
    for (const raw of cleaned.split(/\s+/)) {
      if (raw.length < 2 || skip?.has(raw.replace(EDGE_PUNCTUATION, ""))) continue;
      if (hasCjk(raw)) {
        const segs = segmentCjk(raw);
        // One segment means no segmenter split the run (jieba/tiny-segmenter
        // absent), so the whole run would be a single unmatchable token.
        if (segs.length === 1 && hasCjk(segs[0])) {
          out.push(...cjkBigrams(segs[0]));
        } else {
          for (const seg of segs) {
            if (seg.length >= 1) out.push(seg);
          }
        }
      } else {
        out.push(stem(raw));
      }
    }
    return out;
  }

  private addToLead(term: string): void {
    const lead = term.slice(0, BUCKET_CHARS);
    let bucket = this.termsByLead.get(lead);
    if (!bucket) {
      bucket = new Set();
      this.termsByLead.set(lead, bucket);
    }
    bucket.add(term);
  }

  private removeFromLead(term: string): void {
    const lead = term.slice(0, BUCKET_CHARS);
    const bucket = this.termsByLead.get(lead);
    if (!bucket) return;
    bucket.delete(term);
    if (bucket.size === 0) this.termsByLead.delete(lead);
  }

  // Indexed terms that start with `prefix` and are longer than it, in sorted
  // order so tied scores rank as they did over the sorted vocabulary.
  private termsExtending(prefix: string): string[] {
    const buckets =
      prefix.length >= BUCKET_CHARS
        ? [this.termsByLead.get(prefix.slice(0, BUCKET_CHARS)) ?? []]
        : Array.from(this.termsByLead.entries())
            .filter(([lead]) => lead.startsWith(prefix))
            .map(([, bucket]) => bucket);
    const terms: string[] = [];
    for (const bucket of buckets) {
      for (const term of bucket) {
        if (term.length > prefix.length && term.startsWith(prefix)) terms.push(term);
      }
    }
    return terms.sort();
  }
}
