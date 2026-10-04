const VALID_TAG = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

// Models write reasoning or examples before the payload, never after it, so
// the last complete occurrence of a tag is the one that belongs to the payload.
function lastTagContent(xml: string, tag: string): string | null {
  const close = `</${tag}>`;
  const closeAt = xml.lastIndexOf(close);
  if (closeAt === -1) return null;
  const open = `<${tag}>`;
  const openAt = xml.lastIndexOf(open, closeAt);
  if (openAt === -1) return null;
  return xml.slice(openAt + open.length, closeAt);
}

export function getXmlTag(xml: string, tag: string): string {
  if (!VALID_TAG.test(tag)) return "";
  return lastTagContent(xml, tag)?.trim() ?? "";
}

export function getXmlChildren(
  xml: string,
  parentTag: string,
  childTag: string,
): string[] {
  if (!VALID_TAG.test(parentTag) || !VALID_TAG.test(childTag)) return [];
  const parent = lastTagContent(xml, parentTag);
  if (parent === null) return [];
  const items: string[] = [];
  const re = new RegExp(`<${childTag}>([\\s\\S]*?)</${childTag}>`, "g");
  let m;
  while ((m = re.exec(parent)) !== null) {
    items.push(m[1].trim());
  }
  return items;
}
