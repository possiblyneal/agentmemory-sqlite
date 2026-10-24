export const REFLECT_SYSTEM = `You are a higher-order reasoning engine. Given a cluster of related concepts, facts and lessons, synthesize cross-cutting insights that span multiple individual memories.

Output format (XML):
<insights>
  <insight confidence="0.0-1.0" title="Short descriptive title">
    The higher-order observation or principle. Should be actionable and non-obvious — something that only becomes visible when viewing multiple memories together.
  </insight>
</insights>

Rules:
- Identify patterns, principles, or strategies that span 2+ source items
- Confidence reflects how well-supported the insight is across sources
- Title should be a concise label (under 60 chars)
- Content should be the actual observation (1-3 sentences)
- Prefer actionable insights over abstract summaries
- Skip insights that merely restate a single source item
- Always emit confidence attribute before title attribute
- A cluster may list "Existing Insights", each with an id. When an insight you would write restates one of them, add reinforces="<that id>" after the title attribute instead of writing it as new: <insight confidence="0.8" title="..." reinforces="ins_...">. Use only ids from that list, and write a new insight only for a claim none of them makes`;

export function formatScoredLine(confidence: number, text: string): string {
  return `- [confidence=${confidence}] ${text}`;
}

// Existing Insights shown to the model, strongest first.
export const EXISTING_INSIGHT_LIMIT = 10;
const EXISTING_INSIGHT_CHARS = 300;

export function formatExistingInsightLine(insight: {
  id: string;
  confidence: number;
  title: string;
  content: string;
}): string {
  const content =
    insight.content.length > EXISTING_INSIGHT_CHARS
      ? `${insight.content.slice(0, EXISTING_INSIGHT_CHARS)}…`
      : insight.content;
  return `- [id=${insight.id}] [confidence=${insight.confidence}] ${insight.title}: ${content}`;
}

export function buildReflectPrompt(cluster: {
  concepts: string[];
  facts: Array<{ fact: string; confidence: number }>;
  lessons: Array<{ content: string; confidence: number }>;
  existingInsights?: Array<{ id: string; confidence: number; title: string; content: string }>;
}): string {
  const sections: string[] = [];

  sections.push(`## Concept Cluster: ${cluster.concepts.join(", ")}`);

  if (cluster.facts.length > 0) {
    sections.push(
      "\n## Known Facts",
      ...cluster.facts.map((f) => formatScoredLine(f.confidence, f.fact)),
    );
  }

  if (cluster.lessons.length > 0) {
    sections.push(
      "\n## Lessons Learned",
      ...cluster.lessons.map((l) => formatScoredLine(l.confidence, l.content)),
    );
  }

  if (cluster.existingInsights && cluster.existingInsights.length > 0) {
    sections.push(
      "\n## Existing Insights",
      ...cluster.existingInsights.map(formatExistingInsightLine),
    );
  }

  return `Synthesize higher-order insights from this cluster of related memories:\n\n${sections.join("\n")}`;
}
