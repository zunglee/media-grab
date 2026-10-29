/**
 * A minimal XML reader for DASH manifests.
 *
 * Why not DOMParser: a Chrome MV3 service worker has no DOM, and the background
 * worker is exactly where manifests get parsed. Why not a library: the MPD
 * subset we need is small, and pulling a general XML parser into a content
 * script would cost more than it is worth (CHARTER s2 rule 2).
 *
 * Deliberately NOT supported, because MPDs do not need them and supporting them
 * is where XML parsers grow security holes:
 *   - DTDs, entity declarations and external entities (XXE)
 *   - processing instructions other than the XML declaration
 * A DOCTYPE causes a parse error rather than being skipped.
 *
 * Every parse failure is a MediaGrabError(UNSUPPORTED_MANIFEST), so the user sees "this stream
 * format is not supported" rather than an internal error.
 */

import { ErrorCode, MediaGrabError } from '../../core/errors.ts';

export interface XmlNode {
  name: string;
  /** Tag name without its namespace prefix. */
  localName: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** The highest Unicode code point; a character reference above it names no character. */
const MAX_CODE_POINT = 0x10ffff;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function parseXml(input: string): XmlNode {
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let i = 0;
  const n = input.length;

  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt === -1) break;

    if (lt > i) {
      const text = input.slice(i, lt);
      const top = stack[stack.length - 1];
      if (top && text.trim()) top.text += decodeEntities(text);
    }

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      const body = input.slice(lt + 9, end === -1 ? n : end);
      const top = stack[stack.length - 1];
      if (top) top.text += body;
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (input.startsWith('<!DOCTYPE', lt) || input.startsWith('<!ENTITY', lt)) {
      throw malformed(
        'it contains a DOCTYPE or ENTITY declaration, which MediaGrab refuses for security reasons',
      );
    }
    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    const gt = findTagEnd(input, lt + 1);
    if (gt === -1) break;
    const raw = input.slice(lt + 1, gt);

    if (raw.startsWith('/')) {
      const closed = stack.pop();
      if (!closed) throw malformed('a closing tag has no matching opening tag');
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const node = createNode(body);

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else if (root) throw malformed('it has more than one root element');
    else root = node;

    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  if (!root) throw malformed('it has no root element');
  if (stack.length > 0) throw malformed(`${stack.length} element(s) are never closed`);
  return root;
}

function malformed(reason: string): MediaGrabError {
  return new MediaGrabError(
    ErrorCode.UNSUPPORTED_MANIFEST,
    `This DASH manifest is not readable XML: ${reason}.`,
  );
}

/** Find the `>` that closes a tag, skipping any inside quoted attribute values. */
function findTagEnd(input: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function createNode(body: string): XmlNode {
  let i = 0;
  while (i < body.length && !/\s/.test(body[i] as string)) i += 1;
  const name = body.slice(0, i);
  const attrs = parseAttributes(body.slice(i));
  const colon = name.indexOf(':');
  return {
    name,
    localName: colon === -1 ? name : name.slice(colon + 1),
    attrs,
    children: [],
    text: '',
  };
}

function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = re.exec(input);
  while (match !== null) {
    const key = match[1] as string;
    const value = match[3] ?? match[4] ?? '';
    attrs[key] = decodeEntities(value);
    match = re.exec(input);
  }
  return attrs;
}

function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (!entity.startsWith('#')) return NAMED_ENTITIES[entity] ?? whole;
    const hex = entity[1] === 'x';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!isXmlChar(code)) throw malformed(`it contains an invalid character reference "${whole}"`);
    return String.fromCodePoint(code);
  });
}

/** XML 1.0 s2.2 `Char`: a character reference to anything else is not well-formed. */
function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= MAX_CODE_POINT)
  );
}

/* ---- small query helpers, so callers do not hand-roll tree walks ---- */

export function childrenNamed(node: XmlNode, localName: string): XmlNode[] {
  return node.children.filter((child) => child.localName === localName);
}

export function firstChildNamed(node: XmlNode, localName: string): XmlNode | undefined {
  return node.children.find((child) => child.localName === localName);
}

export function attr(node: XmlNode, name: string): string | undefined {
  const direct = node.attrs[name];
  if (direct !== undefined) return direct;
  // Fall back to a namespace-insensitive lookup (e.g. cenc:default_KID).
  for (const [key, value] of Object.entries(node.attrs)) {
    const colon = key.indexOf(':');
    if (colon !== -1 && key.slice(colon + 1) === name) return value;
  }
  return undefined;
}

export function attrNum(node: XmlNode, name: string): number | undefined {
  const raw = attr(node, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * An xs:unsignedLong attribute (S@t, S@d, @presentationTimeOffset) as a bigint. Epoch-anchored
 * timelines put these above 2^53, where a number would silently round.
 */
export function attrBigInt(node: XmlNode, name: string): bigint | undefined {
  const raw = attr(node, name)?.trim();
  return raw !== undefined && /^\d+$/.test(raw) ? BigInt(raw) : undefined;
}
