/**
 * Media intelligence scoring (PRD s6).
 *
 * Detection is generous on purpose: it reports everything that could be media.
 * This module is what stops the popup from showing thirty rows. A candidate
 * earns points for being a real, substantial, downloadable piece of media and
 * loses them for looking like a thumbnail, an ad bumper or a tracking pixel.
 *
 * Scores are advisory. Nothing is ever hidden permanently: everything below the
 * display threshold stays available in debug mode with its reasons attached.
 *
 * `qualityScore` at the bottom answers a different question (which rendition
 * of ONE media is best) and documents its own curve.
 */
import type { MediaCandidate } from '../core/types.ts';
import { codecFamily } from './format.ts';

/**
 * Candidates below this are hidden from the default popup view. A video earns
 * 30 for its kind alone and an audio file 24 + 12 as a direct file, so real
 * media clears 25 unless there is evidence against it: an ad path (-30), a
 * tiny size (-12), a sub-4-second duration (-10), DRM (-60). A bare image or
 * subtitle URL (+2 / +6, +12 as a file) does not clear it without metadata
 * that makes it look substantial.
 */
export const DISPLAY_THRESHOLD = 25;

export interface Scored {
  score: number;
  reasons: string[];
}

/** Hosts that serve ads and nothing else (matched with their subdomains). */
const AD_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  '2mdn.net',
  'imasdk.googleapis.com',
  'adnxs.com',
  'fwmrm.net',
  'springserve.com',
  'spotxchange.com',
  'innovid.com',
  'moatads.com',
  'adsrvr.org',
];

/**
 * Path segments that mean "ad or tracking, not the media the user came for".
 * Compared against WHOLE segments (a directory name, or a file name without
 * its extension) with `-` and `_` removed, so `/ads/`, `/pre-roll.mp4` and
 * `/pixel.gif` match, while `/videos/pixel-9-pro-review.mp4` and
 * `/vast-landscapes.mp4` - real titles that contain an ad word - do not.
 */
const AD_SEGMENTS = new Set([
  'ad',
  'ads',
  'adserver',
  'adservers',
  'advert',
  'adverts',
  'advertising',
  'preroll',
  'prerolls',
  'midroll',
  'midrolls',
  'postroll',
  'postrolls',
  'bumper',
  'bumpers',
  'vast',
  'vmap',
  'beacon',
  'pixel',
  'tracking',
  'analytics',
]);

const THUMB_PATH =
  /(^|[/._-])(thumb(nail)?s?|poster|preview|sprite|storyboard|scrubbing|avatar|icon|logo)([/._-]|$)/i;

export function scoreCandidate(candidate: MediaCandidate): Scored {
  const reasons: string[] = [];
  let score = 0;

  // A master playlist carries no resolution of its own - the ladder underneath
  // it does. Scoring the parent on its blank metadata would rank a 4K stream
  // below a 720p progressive file, which is the wrong answer for the user.
  const effective = withBestVariantMetrics(candidate);

  score += kindPoints(candidate, reasons);
  score += protocolPoints(candidate, reasons);
  score += resolutionPoints(effective, reasons);
  score += bitratePoints(effective, reasons);
  score += durationPoints(candidate, reasons);
  score += sizePoints(effective, reasons);
  score += tracksPoints(candidate, reasons);
  score += metadataPoints(candidate, reasons);
  score += penalties(candidate, reasons);

  const clamped = Math.max(0, Math.min(ceilingFor(candidate, reasons), Math.round(score)));
  return { score: clamped, reasons };
}

/**
 * The most a candidate can score. A `blob:` URL is bytes held by the page (a
 * MediaSource or an object URL); nothing outside the page can fetch it, so it
 * is kept just under the display threshold: listed in debug mode, where it
 * explains what the player is doing, never offered as a download.
 */
function ceilingFor(candidate: MediaCandidate, reasons: string[]): number {
  if (candidate.protocol === 'blob') {
    reasons.push(`capped at ${DISPLAY_THRESHOLD - 1}: blob URL, not downloadable outside the page`);
    return DISPLAY_THRESHOLD - 1;
  }
  return 100;
}

function isPositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * Returns the candidate with resolution/bitrate/size filled in from its best
 * rendition when it has a ladder and no metrics of its own.
 */
function withBestVariantMetrics(candidate: MediaCandidate): MediaCandidate {
  const variants = candidate.variants;
  if (!variants || variants.length === 0) return candidate;

  let best: MediaCandidate['resolution'];
  let bestBandwidth = 0;
  let bestSize: number | undefined;
  for (const variant of variants) {
    const height = variant.resolution?.height ?? 0;
    if (variant.resolution && height > (best?.height ?? 0)) best = variant.resolution;
    const bandwidth = variant.averageBandwidth ?? variant.bandwidth ?? 0;
    if (bandwidth > bestBandwidth) {
      bestBandwidth = bandwidth;
      bestSize = variant.sizeBytes;
    }
  }

  const size =
    candidate.sizeBytes ??
    bestSize ??
    (bestBandwidth > 0 && isPositive(candidate.duration)
      ? Math.round((bestBandwidth / 8) * candidate.duration)
      : undefined);

  return {
    ...candidate,
    resolution: candidate.resolution ?? best,
    bitrate: candidate.bitrate ?? (bestBandwidth > 0 ? bestBandwidth : undefined),
    ...(size !== undefined ? { sizeBytes: size } : {}),
  };
}

function kindPoints(candidate: MediaCandidate, reasons: string[]): number {
  switch (candidate.kind) {
    case 'video':
      reasons.push('+30 video');
      return 30;
    case 'audio':
      reasons.push('+24 audio');
      return 24;
    case 'subtitle':
      reasons.push('+6 subtitle track');
      return 6;
    case 'image':
      reasons.push('+2 image');
      return 2;
    default:
      reasons.push('+0 unknown kind');
      return 0;
  }
}

function protocolPoints(candidate: MediaCandidate, reasons: string[]): number {
  switch (candidate.protocol) {
    case 'hls':
    case 'dash': {
      // A manifest with parsed variants is the best thing we can find: it is
      // the full quality ladder rather than one arbitrary rendition.
      const variants = candidate.variants?.length ?? 0;
      if (variants > 0) {
        reasons.push(`+20 ${candidate.protocol} manifest with ${variants} variants`);
        return 20;
      }
      reasons.push(`+8 ${candidate.protocol} manifest, variants not parsed yet`);
      return 8;
    }
    case 'progressive':
      reasons.push('+12 direct file');
      return 12;
    case 'data':
      reasons.push('+0 data URL');
      return 0;
    default:
      return 0;
  }
}

function resolutionPoints(candidate: MediaCandidate, reasons: string[]): number {
  const height = candidate.resolution?.height;
  if (!isPositive(height)) return 0;
  if (height >= 2160) {
    reasons.push('+18 4K or larger');
    return 18;
  }
  if (height >= 1440) {
    reasons.push('+16 1440p');
    return 16;
  }
  if (height >= 1080) {
    reasons.push('+14 1080p');
    return 14;
  }
  if (height >= 720) {
    reasons.push('+11 720p');
    return 11;
  }
  if (height >= 480) {
    reasons.push('+7 480p');
    return 7;
  }
  if (height >= 240) {
    reasons.push('+3 low resolution');
    return 3;
  }
  reasons.push('-8 thumbnail-sized');
  return -8;
}

function bitratePoints(candidate: MediaCandidate, reasons: string[]): number {
  const bitrate = candidate.bitrate;
  if (!isPositive(bitrate)) return 0;
  if (bitrate >= 4_000_000) {
    reasons.push('+10 high bitrate');
    return 10;
  }
  if (bitrate >= 1_500_000) {
    reasons.push('+7 medium bitrate');
    return 7;
  }
  if (bitrate >= 300_000) {
    reasons.push('+4 low bitrate');
    return 4;
  }
  reasons.push('+1 very low bitrate');
  return 1;
}

function durationPoints(candidate: MediaCandidate, reasons: string[]): number {
  const duration = candidate.duration;
  if (!isPositive(duration)) return 0;
  if (duration < 4) {
    reasons.push('-10 under 4s, likely a bumper or animation');
    return -10;
  }
  if (duration < 12) {
    reasons.push('-4 very short');
    return -4;
  }
  if (duration >= 60) {
    reasons.push('+8 full-length');
    return 8;
  }
  reasons.push('+4 substantial');
  return 4;
}

function sizePoints(candidate: MediaCandidate, reasons: string[]): number {
  const size = candidate.sizeBytes;
  if (!isPositive(size)) return 0;
  if (size < 51_200) {
    reasons.push('-12 under 50 KB');
    return -12;
  }
  if (size < 512_000) {
    reasons.push('-3 under 500 KB');
    return -3;
  }
  if (size >= 20_000_000) {
    reasons.push('+8 large file');
    return 8;
  }
  reasons.push('+4 reasonable size');
  return 4;
}

function tracksPoints(candidate: MediaCandidate, reasons: string[]): number {
  if (candidate.kind !== 'video') return 0;
  if (candidate.tracks.video && candidate.tracks.audio) {
    reasons.push('+8 video and audio in one stream');
    return 8;
  }
  if (candidate.tracks.video && !candidate.tracks.audio) {
    // Small reward, not a penalty: video-only is how DASH and most HLS ladders
    // ship. The audio comes as a separate file until a muxer exists
    // (ARCHITECTURE.md section 5), so a stream that carries both still wins.
    reasons.push('+2 video-only, audio is a separate track');
    return 2;
  }
  return 0;
}

function metadataPoints(candidate: MediaCandidate, reasons: string[]): number {
  let points = 0;
  if (candidate.title) {
    points += 3;
    reasons.push('+3 has a title');
  }
  if (candidate.format !== 'unknown') {
    points += 3;
    reasons.push('+3 known container');
  }
  if (candidate.source === 'adapter') {
    points += 10;
    reasons.push('+10 site adapter vouched for it');
  }
  return points;
}

function penalties(candidate: MediaCandidate, reasons: string[]): number {
  let points = 0;
  const path = pathOf(candidate.url);

  if (isAdvertising(candidate.url)) {
    points -= 30;
    reasons.push('-30 advertising or tracking path');
  }
  if (THUMB_PATH.test(path) && candidate.kind !== 'video') {
    points -= 15;
    reasons.push('-15 thumbnail or sprite path');
  }
  if (candidate.drm === true) {
    points -= 60;
    reasons.push('-60 DRM protected, cannot be downloaded');
  }
  if (candidate.live === true) {
    points -= 5;
    reasons.push('-5 live stream, no fixed end');
  }
  return points;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function isAdvertising(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (AD_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return true;

  const segments = parsed.pathname.split('/').filter(Boolean);
  const last = segments.length - 1;
  return segments.some((segment, index) => {
    const name = index === last ? segment.replace(/\.[^.]*$/, '') : segment;
    return AD_SEGMENTS.has(safeDecode(name).toLowerCase().replace(/[-_]/g, ''));
  });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Apply scores and sort best-first. Pure: returns new objects. */
export function rank(candidates: MediaCandidate[]): MediaCandidate[] {
  return candidates
    .map((candidate) => {
      const { score, reasons } = scoreCandidate(candidate);
      return { ...candidate, score, scoreReasons: reasons };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.seenAt - b.seenAt);
}

/**
 * Quality score for choosing between renditions of the SAME media (PRD s56).
 * Deliberately different from `scoreCandidate`: it ranks a ladder, it does not
 * decide what is media. 0-100; the parts, in order of weight:
 *
 *  1. Resolution dominates: 10 points per doubling of height above 120 px, up
 *     to 8K (52). One rung is worth 4-6 points (1080p->1440p 4.2, 1440p->4K 5.8).
 *  2. Video bitrate, 8 points per tenfold above 100 kbps, full at 10 Mbps (16).
 *     Within a rung, this is what separates two encodes.
 *  3. Audio bitrate, logarithmic from 32 kbps and full at 160 kbps (12), where
 *     lossy stereo stops audibly improving. Poor audio (64 kbps) against good
 *     (160+) is worth about one rung, which is what stops 4K with 64 kbps audio
 *     beating 1440p with 192 kbps; 128 against 192 kbps is only 2 points.
 *  4. Codec efficiency only breaks near-ties: the whole spread (AV1 6, MPEG-4
 *     Part 2 2.7) is smaller than the smallest rung step, so a better codec
 *     never beats a higher resolution. An unknown codec counts as H.264.
 *  5. Extras: high frame rate +4, audio codec up to +5, surround +2.
 *
 * The maximum is 97, so the final clamp never flattens the top of a ladder.
 * `height` is the 16:9-equivalent height (quality.ts `equivalentHeight`).
 */
export interface QualityInput {
  height?: number;
  bitrate?: number;
  fps?: number;
  codecs?: string[];
  audioBitrate?: number;
  audioCodec?: string;
  audioChannels?: number;
}

/** Below this height there is nothing worth watching; it scores 0. */
const HEIGHT_FLOOR_PX = 120;
const POINTS_PER_HEIGHT_DOUBLING = 10;
/** 8K: log2(4320 / 120) * 10 = 51.7. */
const HEIGHT_POINTS_MAX = 52;

/** Below 100 kbps no video is watchable; it scores 0. */
const BITRATE_FLOOR_BPS = 100_000;
const POINTS_PER_BITRATE_DECADE = 8;
const BITRATE_POINTS_MAX = 16;

const VIDEO_CODEC_POINTS_MAX = 6;

/** Relative bits-per-pixel efficiency. Higher means better quality per byte. */
const VIDEO_CODEC_EFFICIENCY: Record<string, number> = {
  vvc: 1.0,
  av1: 1.0,
  hevc: 0.9,
  vp9: 0.85,
  h264: 0.7,
  vp8: 0.55,
  mpeg4: 0.45,
};
/** A rendition that does not say its codec is most likely H.264, the web default. */
const UNKNOWN_VIDEO_CODEC_EFFICIENCY = VIDEO_CODEC_EFFICIENCY.h264 ?? 0.7;

/** At or above this frame rate a rendition earns points, and its label says so ("1080p60"). */
export const HIGH_FRAME_RATE_FPS = 48;
const HIGH_FRAME_RATE_POINTS = 4;

const AUDIO_FLOOR_KBPS = 32;
const AUDIO_TRANSPARENT_KBPS = 160;
const AUDIO_BITRATE_POINTS_MAX = 12;

const AUDIO_CODEC_POINTS_MAX = 5;
const AUDIO_CODEC_EFFICIENCY: Record<string, number> = {
  flac: 1.0,
  alac: 1.0,
  opus: 0.95,
  aac: 0.8,
  eac3: 0.75,
  ac4: 0.75,
  vorbis: 0.7,
  ac3: 0.6,
  mp3: 0.55,
};
const UNKNOWN_AUDIO_CODEC_EFFICIENCY = 0.5;

const SURROUND_POINTS = 2;

export function qualityScore(input: QualityInput): number {
  let score = 0;

  if (isPositive(input.height)) {
    const doublings = Math.log2(input.height / HEIGHT_FLOOR_PX);
    score += clamp(doublings * POINTS_PER_HEIGHT_DOUBLING, 0, HEIGHT_POINTS_MAX);
  }

  if (isPositive(input.bitrate)) {
    const decades = Math.log10(input.bitrate / BITRATE_FLOOR_BPS);
    score += clamp(decades * POINTS_PER_BITRATE_DECADE, 0, BITRATE_POINTS_MAX);
  }

  const videoFamily = input.codecs
    ?.map(codecFamily)
    .find((family) => family in VIDEO_CODEC_EFFICIENCY);
  if (videoFamily || isPositive(input.height)) {
    const efficiency = videoFamily
      ? (VIDEO_CODEC_EFFICIENCY[videoFamily] ?? UNKNOWN_VIDEO_CODEC_EFFICIENCY)
      : UNKNOWN_VIDEO_CODEC_EFFICIENCY;
    score += efficiency * VIDEO_CODEC_POINTS_MAX;
  }

  if (isPositive(input.fps) && input.fps >= HIGH_FRAME_RATE_FPS) score += HIGH_FRAME_RATE_POINTS;

  if (isPositive(input.audioBitrate)) {
    const kbps = input.audioBitrate / 1000;
    const progress =
      Math.log2(kbps / AUDIO_FLOOR_KBPS) / Math.log2(AUDIO_TRANSPARENT_KBPS / AUDIO_FLOOR_KBPS);
    score += clamp(progress, 0, 1) * AUDIO_BITRATE_POINTS_MAX;
  }
  if (input.audioCodec) {
    const efficiency =
      AUDIO_CODEC_EFFICIENCY[codecFamily(input.audioCodec)] ?? UNKNOWN_AUDIO_CODEC_EFFICIENCY;
    score += efficiency * AUDIO_CODEC_POINTS_MAX;
  }
  if (input.audioChannels !== undefined && input.audioChannels > 2) score += SURROUND_POINTS;

  return Math.round(clamp(score, 0, 100));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
