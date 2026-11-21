const PLACEHOLDER_VALUES = new Set([
  "",
  "your-key-here",
  "sk-ant-...",
  "sk-...",
  "sk-or-...",
  "...",
  "changeme",
  "todo",
  "xxx",
]);

export function isPlaceholderKey(value: string): boolean {
  const v = value.trim();
  return PLACEHOLDER_VALUES.has(v.toLowerCase()) || /^x+$/i.test(v.replace(/[-_]/g, ""));
}
