/**
 * Media identity and URL normalization (PRD s12, s55).
 *
 * The problem: the same file arrives as
 *   https://cdn.example/v.mp4?token=A&_=1
 *   https://cdn.example/v.mp4?token=B&_=2
 * and as a <video> element before and after its metadata loads. That is one
 * video, so it must get one id. We normalize away the volatile parts of the
 * URL and hash what is left, plus the kind.
 *
 * The id is identity only. It deliberately leaves out everything a candidate
 * learns during its life (duration, resolution, size): including them gave the
 * same <video> one id before `loadedmetadata` and another after, i.e. two rows.
 * Those properties are still used, as evidence, where the question is whether
 * two DIFFERENT URLs are the same media: the mirror pass in dedupe.ts.
 *
 * The hash is FNV-1a rather than SHA-256 because it must be synchronous:
 * `crypto.subtle` is async and fingerprinting happens inside hot detection
 * loops. It is not used for security, only for grouping.
 */
import type { MediaCandidate } from '../core/types.ts';

/**
 * Query parameters that change per request without changing the bytes.
 * Removing them is what makes `video.mp4?token=123` and `video.mp4?token=456`
 * collapse into one entry.
 */
const VOLATILE_PARAMS = [
  // Cache busters and timestamps.
  /^_$/i,
  /^cb$/i,
  /^t$/i,
  /^ts$/i,
  /^rnd$/i,
  /^random$/i,
  /^cache[_-]?bust/i,
  // Signatures and expiry: generic, CloudFront, Akamai (hdnts/hdnea/hdntl).
  /token/i,
  /^sig(nature)?$/i,
  /^expires?$/i,
  /^hdn(ts|ea|tl)$/i,
  /^policy$/i,
  /^key[_-]?pair[_-]?id$/i,
  /^auth/i,
  /^session/i,
  /^nonce$/i,
  /^hmac$/i,
  /^md5$/i, // nginx secure_link
  /^st$/i,
  /^e$/i,
  // S3 and GCS presigned URLs: every X-Amz-* / X-Goog-* parameter is part of
  // the signature (algorithm, credential, date, expiry, signed headers), plus
  // the legacy V2 access-key parameters.
  /^x-amz-/i,
  /^x-goog-/i,
  /^awsaccesskeyid$/i,
  /^googleaccessid$/i,
  // Low-Latency HLS delivery directives (RFC 8216bis section 6.2.5): a player
  // reloading a live playlist adds _HLS_msn/_HLS_part/_HLS_skip/_HLS_report to
  // ask for a later version of the SAME playlist.
  /^_HLS_/i,
  // Byte ranges of one file.
  /^range$/i,
  /^start$/i,
  /^end$/i,
];

export function isVolatileParam(name: string): boolean {
  return VOLATILE_PARAMS.some((pattern) => pattern.test(name));
}

/**
 * Canonical form of a media URL: lowercase host, no default port, no hash,
 * no credentials, volatile query params removed, remaining params sorted.
 * Returns the input unchanged when it is not parseable (blob:, data:).
 */
export function normalizeUrl(input: string): string {
  if (input.startsWith('blob:') || input.startsWith('data:')) return input;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }

  url.hash = '';
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }

  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (!isVolatileParam(key)) kept.push([key, value]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);

  return url.toString();
}

/**
 * The URL without its `#fragment`. Two URLs that differ only there name the
 * same document: an anchor or a `#t=90` link does not load a new page.
 */
export function withoutFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** Second-level labels under which ccTLDs register names: bbc.CO.uk, abc.NET.au. */
const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ne', 'or']);

/**
 * Best-effort registrable domain without the Public Suffix List:
 * `r3---sn-ab.googlevideo.com` -> `googlevideo.com`, `www.bbc.co.uk` -> `bbc.co.uk`.
 * Handles the common two-level country suffixes; anything rarer falls back to
 * the last two labels. Good enough for its two uses (naming a site in a title,
 * and grouping CDN mirror hosts), both of which also demand other evidence.
 * IP addresses and single-label hosts come back unchanged.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1] ?? '';
  const second = labels[labels.length - 2] ?? '';
  const take = tld.length === 2 && SECOND_LEVEL_LABELS.has(second) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** 32-bit FNV-1a. Not cryptographic; used only for grouping. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Two rounds with different salts, to make collisions unlikely enough. */
export function hashString(input: string): string {
  const a = fnv1a(input);
  const b = fnv1a(`${input} mediagrab`);
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

export interface FingerprintInput {
  url: string;
  kind: string;
}

/**
 * Stable id for a media resource: its normalized URL and its kind, nothing
 * else. Same bytes behind a re-signed URL, same id; same element before and
 * after its metadata loads, same id. Two renditions have two URLs, so they
 * never share an id.
 */
export function fingerprint(input: FingerprintInput): string {
  return hashString(`${normalizeUrl(input.url)}|${input.kind}`);
}

/**
 * Round to three significant figures (about 1% granularity), so a Content-Length
 * that differs by a few bytes between CDN nodes does not split one file into
 * two entries, while genuinely different renditions stay apart.
 */
export function bucketSize(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  const step = 10 ** Math.max(0, Math.floor(Math.log10(bytes)) - 2);
  return Math.round(bytes / step) * step;
}

export function fingerprintCandidate(candidate: Pick<MediaCandidate, 'url' | 'kind'>): string {
  return fingerprint({ url: candidate.url, kind: candidate.kind });
}
