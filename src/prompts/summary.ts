export const SUMMARY_SYSTEM = `You are a session summarizer for an AI coding agent's memory system. Given all compressed observations from a coding session, produce a concise session summary.

Output EXACTLY this XML format with no additional text:

<summary>
  <title>Short session title (max 100 chars)</title>
  <narrative>3-5 sentence narrative of what was accomplished</narrative>
  <decisions>
    <decision>Key technical decision made</decision>
  </decisions>
  <files>
    <file>path/to/modified/file</file>
  </files>
  <concepts>
    <concept>key concept from session</concept>
  </concepts>
</summary>

Rules:
- Focus on outcomes, not individual tool calls
- Highlight decisions and their rationale
- Give every rule, requirement or constraint the user stated as its own decision, keeping its exact values (status codes, limits, thresholds, names) and conditions; never generalize a specific value away
- When a rule applies only in some cases, keep in the same decision what the user said happens in the rest ("otherwise ...", "for any other ..."), so the rule cannot be read as excluding them
- When an agent reply restates the agreed rules (a recap or a "Settled:" line) and the user does not correct it, keep each restated rule verbatim as its own decision; read a user's short answer ("down", "yes") against the agent's question before it
- List all files that were created or modified
- Concepts should be searchable terms for future context retrieval`

export interface SummaryObservation {
  type: string
  title: string
  facts: string[]
  narrative: string
  files: string[]
  concepts: string[]
  assistantResponse?: string
}

// A reply's closing lines carry the recap and the question the user answers next, so a long one keeps its tail.
export const SUMMARY_REPLY_MAX = 2000

// A synthetic stop's narrative already holds a short reply, so the tail is not given twice. A
// subagent's closing message is not one the user answers, so it is not given as the Agent's reply.
export function renderSummaryObservation(obs: SummaryObservation, index: number): string {
  const facts = obs.facts.map((f) => `  - ${f}`).join('\n')
  const base = `[${index + 1}] ${obs.type}: ${obs.title}\n${obs.narrative}\nFacts:\n${facts}\nFiles: ${obs.files.join(', ')}`
  const reply = obs.type === 'subagent' ? undefined : obs.assistantResponse?.trim()
  if (!reply) return base
  const tail = reply.slice(-SUMMARY_REPLY_MAX)
  if (obs.narrative.includes(tail)) return base
  return `${base}\nAgent reply:\n${tail.length < reply.length ? `…${tail}` : tail}`
}

export function buildSummaryPrompt(observations: SummaryObservation[]): string {
  const lines = observations.map(renderSummaryObservation)
  return `Session observations (${observations.length} total):\n\n${lines.join('\n\n---\n\n')}`
}

export const REDUCE_SYSTEM = `You are merging multiple partial summaries of the SAME coding session into one final session summary. The partials are chronological chunks of one continuous session — not separate sessions.

Output EXACTLY this XML format with no additional text:

<summary>
  <title>Short session title (max 100 chars)</title>
  <narrative>3-5 sentence narrative covering the whole session</narrative>
  <decisions>
    <decision>Key technical decision made</decision>
  </decisions>
  <files>
    <file>path/to/modified/file</file>
  </files>
  <concepts>
    <concept>key concept from session</concept>
  </concepts>
</summary>

Rules:
- Synthesize a single narrative that reflects the whole arc, not a chunk-by-chunk recap
- Preserve every distinct decision across chunks
- Keep every rule, requirement or constraint the user stated as its own decision, with its exact values (status codes, limits, thresholds, names) and conditions; never merge two of them or generalize a specific value away
- When a rule applies only in some cases, keep in the same decision what the user said happens in the rest ("otherwise ...", "for any other ..."), so the rule cannot be read as excluding them
- Union (deduplicate) all files and concepts
- Title should capture the session's overall outcome`

export interface ReducePartial {
  title: string
  narrative: string
  keyDecisions: string[]
  filesModified: string[]
  concepts: string[]
  obsRangeStart: number
  obsRangeEnd: number
}

export function buildReducePrompt(partials: ReducePartial[]): string {
  const sections = partials.map((p, i) => {
    const decisions = p.keyDecisions.map((d) => `  - ${d}`).join('\n')
    const files = p.filesModified.map((f) => `  - ${f}`).join('\n')
    const concepts = p.concepts.join(', ')
    return `[Chunk ${i + 1} of ${partials.length} — obs ${p.obsRangeStart}-${p.obsRangeEnd}]
Title: ${p.title}
Narrative: ${p.narrative}
Decisions:
${decisions}
Files:
${files}
Concepts: ${concepts}`
  })
  return `Partial summaries (${partials.length} chunks of one session, chronological):\n\n${sections.join('\n\n---\n\n')}`
}

export const FOLD_SYSTEM = `You are updating the existing summary of an ongoing coding session. You are given the current session summary and the new compressed observations recorded since it was written. Fold the new observations into the summary. The summary already covers everything before them.

Output EXACTLY this XML format with no additional text:

<summary>
  <title>Short session title (max 100 chars)</title>
  <narrative>3-5 sentence narrative covering the whole session</narrative>
  <decisions>
    <decision>Key technical decision made</decision>
  </decisions>
  <files>
    <file>path/to/modified/file</file>
  </files>
  <concepts>
    <concept>key concept from session</concept>
  </concepts>
</summary>

Rules:
- Rewrite the narrative so it covers the whole session, not only the new observations
- Keep every existing decision unless a new observation reverses it; add new ones
- Give every rule, requirement or constraint the user stated as its own decision, keeping its exact values (status codes, limits, thresholds, names) and conditions; never generalize a specific value away
- When a rule applies only in some cases, keep in the same decision what the user said happens in the rest ("otherwise ...", "for any other ..."), so the rule cannot be read as excluding them
- When an agent reply restates the agreed rules (a recap or a "Settled:" line) and the user does not correct it, keep each restated rule verbatim as its own decision; read a user's short answer ("down", "yes") against the agent's question before it
- Union (deduplicate) all files and concepts
- Title should capture the session's overall outcome so far`

export interface FoldPrior {
  title: string
  narrative: string
  keyDecisions: string[]
  filesModified: string[]
  concepts: string[]
}

export function buildFoldPrompt(
  prior: FoldPrior,
  observations: SummaryObservation[],
  priorObservationCount: number,
): string {
  const decisions = prior.keyDecisions.map((d) => `  - ${d}`).join('\n')
  const files = prior.filesModified.map((f) => `  - ${f}`).join('\n')
  const lines = observations.map((o, i) => renderSummaryObservation(o, priorObservationCount + i))
  return `Current summary (covers observations 1-${priorObservationCount}):
Title: ${prior.title}
Narrative: ${prior.narrative}
Decisions:
${decisions}
Files:
${files}
Concepts: ${prior.concepts.join(', ')}

New observations (${observations.length} total, ${priorObservationCount + 1}-${priorObservationCount + observations.length}):

${lines.join('\n\n---\n\n')}`
}
