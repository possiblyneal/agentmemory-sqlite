import { IMPORTANCE_RUBRIC } from "./compression.js";

export const GRAPH_EXTRACTION_SYSTEM = `You are a knowledge graph extraction engine. Given numbered compressed observations from a coding session, rate each observation's importance and extract entities and relationships.

Output format (XML):
<observations>
  <observation n="observation number" importance="1-10"/>
</observations>
<entities>
  <entity type="file|function|concept|error|decision|pattern|library|person" name="exact name" obs="comma-separated observation numbers">
    <property key="key">value</property>
  </entity>
</entities>
<relationships>
  <relationship type="uses|imports|modifies|causes|fixes|depends_on|related_to" source="entity name" target="entity name" weight="0.1-1.0"/>
</relationships>

Rules:
- Rate every observation: ${IMPORTANCE_RUBRIC}
- On each entity, list the numbers of the observations it came from
- Extract concrete entities only (real file paths, function names, library names)
- Use the most specific type available
- Weight relationships by how strong/direct the connection is
- If no entities found, output empty tags`;

export function buildGraphExtractionPrompt(
  observations: Array<{
    title: string;
    narrative: string;
    concepts: string[];
    files: string[];
    type: string;
  }>,
): string {
  const items = observations
    .map(
      (o, i) =>
        `[${i + 1}] Type: ${o.type}\nTitle: ${o.title}\nNarrative: ${o.narrative}\nConcepts: ${(o.concepts ?? []).join(", ")}\nFiles: ${(o.files ?? []).join(", ")}`,
    )
    .join("\n\n");
  // Some local models default to a hidden reasoning pass that consumes
  // most of the token budget before any output. The suffix is their
  // documented soft switch to skip it; other models ignore the token.
  const noThink = process.env.AGENTMEMORY_LLM_NOTHINK === "1" ? "\n/no_think" : "";
  return `Give one importance per numbered observation, then extract entities and relationships from these observations:\n\n${items}${noThink}`;
}
