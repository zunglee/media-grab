/**
 * HLS attribute-list parsing (RFC 8216 s4.2).
 *
 * The naive `split(',')` is wrong: CODECS="avc1.4d401f,mp4a.40.2" contains a
 * comma inside a quoted string. This tokenizer walks the list character by
 * character and only breaks on commas at quote depth zero.
 */

export type AttributeValue = string;

export function parseAttributeList(input: string): Map<string, AttributeValue> {
  const out = new Map<string, AttributeValue>();
  let index = 0;
  const length = input.length;

  while (index < length) {
    while (index < length && (input[index] === ' ' || input[index] === ',')) index += 1;
    if (index >= length) break;

    const eq = findUnquoted(input, index, '=');
    if (eq === -1) break;
    const name = input.slice(index, eq).trim();
    index = eq + 1;

    let value: string;
    if (input[index] === '"') {
      const end = input.indexOf('"', index + 1);
      if (end === -1) {
        value = input.slice(index + 1);
        index = length;
      } else {
        value = input.slice(index + 1, end);
        index = end + 1;
      }
    } else {
      const comma = input.indexOf(',', index);
      const end = comma === -1 ? length : comma;
      value = input.slice(index, end).trim();
      index = end;
    }

    if (name) out.set(name.toUpperCase(), value);
  }

  return out;
}

function findUnquoted(input: string, from: number, target: string): number {
  let quoted = false;
  for (let i = from; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === target) return i;
  }
  return -1;
}

export function attrNumber(attrs: Map<string, string>, key: string): number | undefined {
  const raw = attrs.get(key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function attrBool(attrs: Map<string, string>, key: string): boolean {
  return attrs.get(key)?.toUpperCase() === 'YES';
}

/** RESOLUTION=1920x1080 */
export function attrResolution(
  attrs: Map<string, string>,
  key = 'RESOLUTION',
): { width: number; height: number } | undefined {
  const raw = attrs.get(key);
  if (!raw) return undefined;
  const match = /^(\d+)\s*[xX]\s*(\d+)$/.exec(raw.trim());
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** FRAME-RATE=29.970 */
export function attrFrameRate(attrs: Map<string, string>): number | undefined {
  const value = attrNumber(attrs, 'FRAME-RATE');
  return value !== undefined && value > 0 ? value : undefined;
}

export function attrCodecs(attrs: Map<string, string>): string[] | undefined {
  const raw = attrs.get('CODECS');
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** EXT-X-BYTERANGE / BYTERANGE: "<length>[@<offset>]" */
export function parseByteRange(raw: string): { length: number; offset?: number } | undefined {
  const match = /^(\d+)(?:@(\d+))?$/.exec(raw.trim());
  if (!match) return undefined;
  const length = Number(match[1]);
  const offset = match[2] !== undefined ? Number(match[2]) : undefined;
  return offset === undefined ? { length } : { length, offset };
}
