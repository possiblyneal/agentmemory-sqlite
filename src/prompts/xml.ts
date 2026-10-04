const VALID_TAG = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

// An open tag may carry attributes but never `<` or `>`, so a match cannot run
// across a tag boundary; a self-closing `<tag/>` is not an open tag.
const openTag = (tag: string) => `<${tag}(?:\\s[^<>]*)?(?<!/)>`;
const closeTag = (tag: string) => `</${tag}\\s*>`;

function firstElementContent(xml: string, tag: string): string | null {
  const m = xml.match(
    new RegExp(`${openTag(tag)}([\\s\\S]*?)${closeTag(tag)}`),
  );
  return m ? m[1] : null;
}

// Models write reasoning or format examples before the payload, never after
// it, so the payload is the last complete root element. Walking back from the
// last close tag and balancing nested open/close pairs keeps a root element the
// model quotes inside its own payload from being taken for the payload.
// Returns the root's inner text, or the whole response when no root is present.
export function getXmlPayload(xml: string, rootTag: string): string {
  if (!VALID_TAG.test(rootTag)) return xml;
  const re = new RegExp(`(${openTag(rootTag)})|${closeTag(rootTag)}`, "g");
  const tags: { open: boolean; start: number; end: number }[] = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    tags.push({
      open: m[1] !== undefined,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  let lastClose = tags.length - 1;
  while (lastClose >= 0 && tags[lastClose].open) lastClose--;
  if (lastClose < 0) return xml;
  let depth = 0;
  for (let i = lastClose; i >= 0; i--) {
    depth += tags[i].open ? -1 : 1;
    if (depth === 0) return xml.slice(tags[i].end, tags[lastClose].start);
  }
  return xml;
}

export function getXmlTag(xml: string, tag: string): string {
  if (!VALID_TAG.test(tag)) return "";
  return firstElementContent(xml, tag)?.trim() ?? "";
}

export function getXmlChildren(
  xml: string,
  parentTag: string,
  childTag: string,
): string[] {
  if (!VALID_TAG.test(parentTag) || !VALID_TAG.test(childTag)) return [];
  const parent = firstElementContent(xml, parentTag);
  if (parent === null) return [];
  const items: string[] = [];
  const re = new RegExp(
    `${openTag(childTag)}([\\s\\S]*?)${closeTag(childTag)}`,
    "g",
  );
  let m;
  while ((m = re.exec(parent)) !== null) {
    items.push(m[1].trim());
  }
  return items;
}
