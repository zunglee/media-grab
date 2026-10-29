/**
 * URL redaction used by diagnostics exports, the report-a-site payload and
 * non-debug logging. Signed media URLs routinely carry bearer-equivalent
 * tokens; those must never leave the machine.
 *
 * Tokens hide in four places, and each has its own rule below:
 *   1. a query parameter with a credential-like name (`?token=`, `?X-Amz-Signature=`)
 *   2. a path segment that is a name=value pair (Akamai `/hdntl=exp=...~hmac=.../`,
 *      matrix parameters such as `;jsessionid=`)
 *   3. a path segment or query value that IS the token: a JWT, or a long hex or
 *      base64url blob
 *   4. a whole URL nested in a query value (`?src=https%3A%2F%2F...%3Ftoken%3D...`),
 *      which is decoded, redacted by these same rules, and re-encoded
 * When a rule is unsure it redacts: a report that loses a harmless id is fine,
 * one that leaks a token is not. Human-readable slugs and file names are kept,
 * so a report still says which page and which file it was about.
 */

const REDACTED = 'REDACTED';

/** Parameter names that carry credentials, matched anywhere in the name. */
const SENSITIVE_NAME =
  /token|auth|key|sig|secret|session|password|passwd|hmac|policy|credential|expires|hdnt|hdnea|nonce|jwt|md5/i;
/**
 * Short names CDNs use for a signature and its expiry, matched whole: nginx
 * secure_link's `?md5=...&expires=`, and the `?st=...&e=` form several CDNs
 * sign with. Too short to match anywhere in a name without hitting harmless
 * parameters (`?type=`, `?e` inside `?quality=`).
 */
const SHORT_SIGNATURE_NAME = /^(st|e|s|h|hash)$/i;

/** Three base64url parts, the first two JSON objects (`eyJ` is base64 for `{"`). */
const JWT = /^eyJ[\w-]+\.eyJ[\w-]*\.[\w-]*$/;

/**
 * Opaque tokens are at least 32 characters: 128 bits as hex, 192 as
 * base64url - the shortest signatures and session tokens CDNs issue (an HMAC
 * truncated to 128 bits, a random 128-bit key). Shorter opaque strings are
 * usually content ids (an 11-character video id) that name public media
 * rather than grant access to it.
 */
const OPAQUE_MIN_LENGTH = 32;
const HEX = /^[0-9a-f]+$/i;
const BASE64URL = /^[A-Za-z0-9_+/=-]+$/;
/** Lowercase words joined by `-` or `_`: a slug a human wrote, not a token. */
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;

/** Nested URLs deeper than this are left as found (a real URL nests one level). */
const MAX_NESTING = 3;

export function redactUrl(input: string): string {
  return redactUrlAt(input, 0);
}

function redactUrlAt(input: string, depth: number): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input.length > 120 ? `${input.slice(0, 120)}...` : input;
  }

  if (url.protocol === 'data:') return 'data:[redacted]';
  if (url.protocol === 'blob:') return 'blob:[redacted]';

  url.username = '';
  url.password = '';
  url.hash = '';
  url.pathname = url.pathname.split('/').map(redactPathSegment).join('/');

  const params = [...url.searchParams.entries()];
  const redacted = params.map(([key, value]): [string, string] => [
    key,
    redactQueryValue(key, value, depth),
  ]);
  if (redacted.some(([, value], index) => value !== params[index]?.[1])) {
    url.search = '';
    for (const [key, value] of redacted) url.searchParams.append(key, value);
  }

  return url.toString();
}

function redactQueryValue(key: string, value: string, depth: number): string {
  if (SENSITIVE_NAME.test(key) || SHORT_SIGNATURE_NAME.test(key) || isToken(value)) {
    return REDACTED;
  }
  if (/^https?:\/\//i.test(value) && depth < MAX_NESTING) return redactUrlAt(value, depth + 1);
  return value;
}

function redactPathSegment(segment: string): string {
  if (isToken(safeDecode(segment))) return REDACTED;
  if (!segment.includes('=')) return segment;
  // `name=value` pairs inside one segment, `;`-separated. The whole value of a
  // sensitive pair goes: an Akamai `hdntl=exp=..~acl=..~hmac=..` token is one
  // value with its own inner structure.
  return segment
    .split(';')
    .map((pair) => {
      const equals = pair.indexOf('=');
      if (equals <= 0) return pair;
      const name = pair.slice(0, equals);
      return SENSITIVE_NAME.test(safeDecode(name)) ? `${name}=${REDACTED}` : pair;
    })
    .join(';');
}

/** A value that is itself a credential, whatever it is called. */
function isToken(value: string): boolean {
  if (JWT.test(value)) return true;
  // Hex, including UUID-style dashes: no human writes 32 hex digits.
  const compact = value.replace(/-/g, '');
  if (compact.length >= OPAQUE_MIN_LENGTH && HEX.test(compact)) return true;
  return value.length >= OPAQUE_MIN_LENGTH && BASE64URL.test(value) && !SLUG.test(value);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Domain only. Used where even a path would be identifying. */
export function domainOf(input: string): string {
  try {
    return new URL(input).hostname;
  } catch {
    return 'unknown';
  }
}

/** Deep-redact an object graph for a diagnostics export. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === 'string') return (looksLikeUrl(value) ? redactUrl(value) : value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1)) as T;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/cookie|authorization|referer|origin|useragent|user_agent/i.test(key)) {
        out[key] = 'REDACTED';
        continue;
      }
      out[key] = redactDeep(item, depth + 1);
    }
    return out as T;
  }
  return value;
}

function looksLikeUrl(value: string): boolean {
  return /^(https?|blob|data):/i.test(value);
}
