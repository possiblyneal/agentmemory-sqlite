export const CHARS_PER_TOKEN = 3;

// Overcounts measured content by ~17%, the safe direction for a budget.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
