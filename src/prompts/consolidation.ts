export const SEMANTIC_MERGE_SYSTEM = `You are a memory consolidation engine. Given overlapping episodic memories (session summaries), extract stable factual knowledge.

Output format (XML):
<facts>
  <fact confidence="0.0-1.0" subject="what the fact is about" relation="the attribute or property" object="its current value">Concise factual statement</fact>
</facts>

Rules:
- Extract only facts that appear in 2+ episodes or are highly confident
- Confidence reflects how well-supported the fact is across episodes
- Combine overlapping information into single concise facts
- Skip ephemeral details (specific error messages, temporary states)
- subject, relation and object are optional: give all three only when the fact states a single value for an attribute of a subject (for example subject="indentation", relation="style", object="tabs"). Use the same short wording for the same subject and relation across facts. Omit all three for any other fact`;

export function buildSemanticMergePrompt(
  episodes: Array<{ title: string; narrative: string; concepts: string[] }>,
): string {
  const items = episodes
    .map(
      (e, i) =>
        `[Episode ${i + 1}]\nTitle: ${e.title}\nNarrative: ${e.narrative}\nConcepts: ${e.concepts.join(", ")}`,
    )
    .join("\n\n");
  return `Consolidate these episodic memories into stable facts:\n\n${items}`;
}
