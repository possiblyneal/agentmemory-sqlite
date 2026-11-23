import type { SemanticMemory } from "../types.js";

type Alias = NonNullable<SemanticMemory["aliases"]>[number];

function isAlias(value: unknown): value is Alias {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return [row.subject, row.relation, row.object, row.fact].every(
    field => typeof field === "string" && field.trim().length > 0,
  );
}

export function validFactAliases(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isAlias));
}

export function factAliases(value: unknown): Alias[] {
  return Array.isArray(value) ? value.filter(isAlias) : [];
}
