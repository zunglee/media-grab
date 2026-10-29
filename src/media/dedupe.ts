/**
 * Collapse candidates that are the same resource seen more than once.
 *
 * Two passes, because "same URL" and "same media at another URL" need
 * different evidence:
 *  1. Identity: the same id (fingerprint.ts: normalized URL + kind) -> merge.
 *     One <video> seen before and after its metadata loaded, plus the network
 *     observer seeing the same file, is one row.
 *  2. Mirror: another host of the same site serving the same path and query,
 *     with the same intrinsic properties (duration, measured size, resolution)
 *     -> merge, because load-balanced CDNs hand one asset out from
 *     `r3.cdn.example` and `r7.cdn.example`. A candidate with no duration and
 *     no measured size offers no evidence, so this pass never merges it.
 * The query string is part of both keys: `get_video.php?id=111` and `?id=222`
 * are two videos behind one script.
 *
 * Merging is not "pick one": each source knows different things. The network
 * observer knows Content-Length, the DOM knows the poster and the title, the
 * manifest knows the codecs. The merged record is the union.
 */
import type { MediaCandidate } from '../core/types.ts';
import { bucketSize, normalizeUrl, registrableDomain } from './fingerprint.ts';

/** How much a source is trusted when two records disagree on the same field. */
const SOURCE_RANK: Record<MediaCandidate['source'], number> = {
  adapter: 4,
  network: 3,
  'page-hook': 2,
  'dom-element': 1,
  'dom-attribute': 0,
};

export function dedupe(candidates: MediaCandidate[]): MediaCandidate[] {
  const byId = new Map<string, MediaCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.id);
    byId.set(candidate.id, existing ? merge(existing, candidate) : candidate);
  }

  const byNearKey = new Map<string, MediaCandidate>();
  for (const candidate of byId.values()) {
    const key = nearKey(candidate);
    const existing = byNearKey.get(key);
    byNearKey.set(key, existing ? merge(existing, candidate) : candidate);
  }

  return [...byNearKey.values()];
}

/**
 * Grouping key for the mirror pass: site + path + kept query (no scheme, no
 * exact host) plus the intrinsic properties that make it the same media.
 * Without a duration or a measured size there is no evidence, and the key is
 * the candidate's own id, so it only ever groups with itself.
 */
export function nearKey(candidate: MediaCandidate): string {
  const duration = positive(candidate.duration);
  const measuredSize = candidate.sizeEstimated === true ? undefined : positive(candidate.sizeBytes);
  if (duration === undefined && measuredSize === undefined) return `id:${candidate.id}`;

  const resolution = candidate.resolution
    ? `${candidate.resolution.width}x${candidate.resolution.height}`
    : '';
  return [
    siteLocation(candidate.url),
    candidate.kind,
    candidate.protocol,
    resolution,
    duration !== undefined ? String(Math.round(duration)) : '',
    measuredSize !== undefined ? String(bucketSize(measuredSize)) : '',
    candidate.language ?? '',
  ].join('|');
}

/** `https://r3.cdn.example/v.mp4?id=1&token=x` -> `cdn.example/v.mp4?id=1`. */
function siteLocation(url: string): string {
  const normalized = normalizeUrl(url);
  try {
    const parsed = new URL(normalized);
    if (!parsed.hostname) return normalized; // blob: - unique per object anyway
    return `${registrableDomain(parsed.hostname)}${parsed.pathname}${parsed.search}`;
  } catch {
    return normalized;
  }
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function merge(a: MediaCandidate, b: MediaCandidate): MediaCandidate {
  const [primary, secondary] = SOURCE_RANK[a.source] >= SOURCE_RANK[b.source] ? [a, b] : [b, a];

  const merged: MediaCandidate = {
    ...secondary,
    ...stripUndefined(primary),
    // Union semantics for the fields where "we saw it" beats "we did not".
    id: primary.id,
    seenAt: Math.min(a.seenAt, b.seenAt),
    drm: a.drm === true || b.drm === true,
    live: a.live === true || b.live === true,
    tracks: {
      video: a.tracks.video || b.tracks.video,
      audio: a.tracks.audio || b.tracks.audio,
    },
  };

  // Prefer any concrete value over a missing one, regardless of source rank.
  merged.kind = known(primary.kind, secondary.kind);
  merged.format = known(primary.format, secondary.format);
  merged.protocol = known(primary.protocol, secondary.protocol);
  merged.resolution = primary.resolution ?? secondary.resolution;
  merged.duration = firstNumber(primary.duration, secondary.duration);
  merged.bitrate = firstNumber(primary.bitrate, secondary.bitrate);
  merged.fps = firstNumber(primary.fps, secondary.fps);
  merged.posterUrl = primary.posterUrl ?? secondary.posterUrl;
  merged.title = primary.title ?? secondary.title;
  merged.mimeType = primary.mimeType ?? secondary.mimeType;
  merged.codecs = primary.codecs ?? secondary.codecs;
  merged.language = primary.language ?? secondary.language;
  merged.label = primary.label ?? secondary.label;
  merged.variants = pickLonger(primary.variants, secondary.variants);
  merged.audioTracks = pickLonger(primary.audioTracks, secondary.audioTracks);
  merged.subtitles = pickLonger(primary.subtitles, secondary.subtitles);
  merged.drmSystem = primary.drmSystem ?? secondary.drmSystem;

  // A measured size beats an estimated one.
  const measured = [primary, secondary].find(
    (c) => c.sizeBytes !== undefined && c.sizeEstimated !== true,
  );
  const estimated = [primary, secondary].find((c) => c.sizeBytes !== undefined);
  if (measured) {
    merged.sizeBytes = measured.sizeBytes;
    merged.sizeEstimated = false;
  } else if (estimated) {
    merged.sizeBytes = estimated.sizeBytes;
    merged.sizeEstimated = true;
  }

  return merged;
}

function known<T extends string>(preferred: T, fallback: T): T {
  return preferred === 'unknown' ? fallback : preferred;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as Partial<T>;
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => positive(value) !== undefined);
}

function pickLonger<T>(a: T[] | undefined, b: T[] | undefined): T[] | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.length >= b.length ? a : b;
}

/**
 * Whether two URLs name the same rendition: equal once the parts that change
 * per request (signatures, expiry, cache busters; see `normalizeUrl`) are
 * removed. A shared file name is NOT evidence: `/v/111/1080p/index.m3u8` and
 * `/v/222/1080p/index.m3u8` are different videos.
 *
 * URL identity only. DASH renditions can share one URL (the MPD, or one
 * BaseURL with byte ranges), so a caller comparing DASH renditions must also
 * compare the representation id.
 */
export function sameRenditionUrl(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b);
}
