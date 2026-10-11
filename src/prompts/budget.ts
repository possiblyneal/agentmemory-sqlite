// Largest prompt, in characters, one consolidation LLM call may carry. A reflect
// cluster once reached 100k+ tokens on the Operator's broker and starved sibling
// slots during prefill. ~8k tokens at the tree's chars/3 estimate.
export const CONSOLIDATION_PROMPT_CHARS = 24_000;
