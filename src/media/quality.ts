/**
 * Turning a quality ladder into the three choices a normal person wants
 * (PRD s13, s37, s57), plus the audio pairing that PRD s56 asks for.
 *
 * The popup's primary action is "Best Download". Everything here exists so that
 * button can be right without the user knowing what a codec is. What "best"
 * means is one written rule (ARCHITECTURE.md D20), `compareRenditions`, and
 * every "best" in the product goes through it:
 *
 *   pickBestDownload(candidates)  the popup button, the shortcut, the context menu
 *     -> bestRenditionOf(candidate)   the rendition, and its audio when split
 *   bestVariantOf(candidate)      a download queued without a rendition (task-factory.ts)
 *   recommend(candidate)[0]       the row's own download button
 *
 * Only renditions that can be saved take part (media/saveability.ts, D21).
 */
import type { MediaCandidate, MediaVariant, Resolution } from '../core/types.ts';
import { codecFamily, isAudioCodec } from './format.ts';
import { isSaveable, renditionSaveability, saveabilityOf } from './saveability.ts';
import { HIGH_FRAME_RATE_FPS, qualityScore } from './score.ts';

export type RecommendationKind = 'best' | 'balanced' | 'smallest';

export interface Recommendation {
  kind: RecommendationKind;
  label: string;
  variant: MediaVariant;
  /**
   * The audio that goes with a video-only variant. It weighs in the choice of
   * "best", and "best" downloads it next to the video as a second file: there
   * is no muxer to join them (ARCHITECTURE.md section 5).
   */
  audio?: MediaVariant;
  /** Bytes the video file will take - the variant alone; the audio is its own file. */
  sizeBytes?: number;
  sizeEstimated: boolean;
  reason: string;
}

/** One thing "best" can mean for a candidate: a rendition, and the audio it needs. */
export interface Rendition {
  variant: MediaVariant;
  /**
   * The separate audio track a video-only `variant` plays with (D20). Two
   * files, since nothing muxes; absent when the video carries its own sound,
   * or when no audio track can be saved.
   */
  audio?: MediaVariant;
}

/** What "Best download" queues: one candidate, in its best rendition, with its audio if split. */
export interface BestDownload {
  candidate: MediaCandidate;
  /** Absent for a direct file, and for a manifest with no ladder (an HLS media playlist on its own). */
  variant?: MediaVariant;
  audio?: MediaVariant;
}

/** Standard rung labels, tallest first. */
const LADDER: Array<{ height: number; label: string }> = [
  { height: 4320, label: '8K' },
  { height: 2160, label: '4K' },
  { height: 1440, label: '1440p' },
  { height: 1080, label: '1080p' },
  { height: 720, label: '720p' },
  { height: 480, label: '480p' },
  { height: 360, label: '360p' },
  { height: 240, label: '240p' },
  { height: 144, label: '144p' },
];

/**
 * A rendition lands on a rung when it is within 10% of it, because encoders
 * crop to multiples of 8 or 16: a 1918x1076 encode is "1080p" to a user.
 */
const RUNG_TOLERANCE = 0.9;

/** The tallest rung "Best balance" will pick. */
const BALANCED_MAX_HEIGHT = 1080;

/**
 * The height a resolution is equivalent to on the 16:9 ladder: the larger of
 * its short side and its long side scaled to 16:9. So portrait video is
 * labelled by its short side (1080x1920 is 1080p) and letterboxed or
 * ultrawide video by its width (1920x800 is 1080p, 3840x1600 is 4K), which is
 * how players label them.
 */
export function equivalentHeight(resolution: Resolution): number {
  const short = Math.min(resolution.width, resolution.height);
  const long = Math.max(resolution.width, resolution.height);
  return Math.max(short, (long * 9) / 16);
}

/**
 * The one rule for naming a resolution ("720p", "1080p60", "4K"). The popup,
 * the file name template and the ladder all use it, so they always agree.
 */
export function resolutionLabel(resolution: Resolution, fps?: number): string {
  const rung = rungOf(resolution);
  const base = rung.label ?? `${Math.round(rung.height)}p`;
  return fps !== undefined && fps >= HIGH_FRAME_RATE_FPS ? `${base}${Math.round(fps)}` : base;
}

/** The ladder rung a resolution sits on; below the ladder, its own height and no label. */
function rungOf(resolution: Resolution): { height: number; label?: string } {
  const height = equivalentHeight(resolution);
  return LADDER.find((entry) => height >= entry.height * RUNG_TOLERANCE) ?? { height };
}

/** Label for one rendition: its rung, or for audio its codec and bitrate. */
export function qualityLabel(variant: MediaVariant): string {
  if (variant.resolution) return resolutionLabel(variant.resolution, variant.fps);
  if (variant.kind === 'audio') return audioLabel(variant);
  const bandwidth = bandwidthOf(variant);
  return variant.label ?? (bandwidth > 0 ? formatBitrate(bandwidth) : 'Unknown');
}

function audioLabel(variant: MediaVariant): string {
  const bandwidth = variant.bandwidth ?? 0;
  const codec = variant.codecs?.[0] ? codecFamily(variant.codecs[0]).toUpperCase() : undefined;
  const parts = [
    variant.label ?? variant.language ?? 'Audio',
    codec,
    bandwidth > 0 ? formatBitrate(bandwidth) : undefined,
  ];
  return parts.filter(Boolean).join(' - ');
}

function formatBitrate(bitsPerSecond: number): string {
  return bitsPerSecond >= 1_000_000
    ? `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`
    : `${Math.round(bitsPerSecond / 1000)} kbps`;
}

/**
 * Video renditions only, best first, one entry per quality rung. A rendition
 * without a resolution (an HLS variant with CODECS but no RESOLUTION) is its
 * own rung, keyed by bitrate: grouping them all as "Unknown" kept one.
 */
export function videoLadder(variants: MediaVariant[]): MediaVariant[] {
  const video = variants.filter((variant) => variant.tracks.video);
  const byRung = new Map<string, MediaVariant>();
  for (const variant of video) {
    const key = variant.resolution ? qualityLabel(variant) : `bitrate:${bandwidthOf(variant)}`;
    const existing = byRung.get(key);
    if (!existing || scoreOf(variant) > scoreOf(existing)) byRung.set(key, variant);
  }
  return [...byRung.values()].sort(
    (a, b) => heightOf(b) - heightOf(a) || bandwidthOf(b) - bandwidthOf(a),
  );
}

export function audioLadder(variants: MediaVariant[]): MediaVariant[] {
  return variants
    .filter((variant) => variant.tracks.audio && !variant.tracks.video)
    .sort((a, b) => bandwidthOf(b) - bandwidthOf(a));
}

/**
 * Audio that accompanies the programme rather than being its sound: a
 * narration of the picture for blind viewers (DASH Role "description"), or a
 * commentary track. Often the highest bitrate on offer, since it is the
 * programme's mix with a voice on top - which is exactly why bitrate alone
 * picked it.
 */
const COMPANION_AUDIO_ROLES: ReadonlySet<string> = new Set(['description', 'commentary']);

/**
 * The audio track to pair with a video-only variant. Each step narrows the
 * choice only when something is left after it:
 *
 *   1. the AUDIO group the variant expects (HLS says; DASH has no groups)
 *   2. the programme's own sound: no audio description or commentary
 *   3. the track the manifest marks as the default (HLS DEFAULT=YES, DASH
 *      Role "main"), and only in that track's language - a DASH manifest can
 *      mark a main track per language, and the first one listed is the
 *      original
 *   4. then the highest bitrate
 *
 * A DASH dub is not excluded: it is the programme, in another language, and
 * loses to the default wherever the manifest marks one. Returns undefined when
 * the video already carries audio.
 */
export function pairAudioFor(
  variant: MediaVariant,
  audioTracks: MediaVariant[],
): MediaVariant | undefined {
  if (variant.tracks.audio) return undefined;
  if (audioTracks.length === 0) return undefined;

  const group = variant.audioGroupId;
  const inGroup = group ? audioTracks.filter((track) => track.audioGroupId === group) : audioTracks;
  const pool = inGroup.length > 0 ? inGroup : audioTracks;

  const programme = pool.filter((track) => !COMPANION_AUDIO_ROLES.has(track.role ?? ''));
  const eligible = programme.length > 0 ? programme : pool;

  // The default track sets the language; with none marked, the first listed
  // does - a player's own choice - so a louder dub never wins on bitrate alone.
  const marked = eligible.find((track) => track.default === true);
  const main = marked ?? eligible[0];
  const candidates = eligible.filter(
    (track) => (!marked || track.default === true) && track.language === main?.language,
  );

  return [...candidates].sort((a, b) => bandwidthOf(b) - bandwidthOf(a))[0];
}

/** Why "best" is best, in the words the diagnostic report shows (D20). */
const BEST_REASON = 'With sound where possible, then the highest resolution and bitrate.';

/**
 * Best / balanced / smallest, among the renditions that can be saved.
 *
 * "Best" is the D20 rule (`compareRenditions`). "Balanced" is the same rule at
 * or below 1080p, which is what most people actually want on a laptop.
 * "Smallest" is the smallest complete download.
 */
export function recommend(candidate: MediaCandidate): Recommendation[] {
  const evaluated = rankRenditions(candidate, saveablePool(candidate), saveableAudio(candidate));
  const best = evaluated[0];
  if (!best) return [];
  const balanced =
    evaluated.find((entry) => {
      const resolution = entry.variant.resolution;
      return !resolution || rungOf(resolution).height <= BALANCED_MAX_HEIGHT;
    }) ?? best;
  const smallest = [...evaluated]
    .filter((entry) => entry.sizeBytes !== undefined)
    .sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))[0];

  const out: Recommendation[] = [
    toRecommendation('best', 'Best quality', best, candidate, BEST_REASON),
  ];
  if (balanced.variant.id !== best.variant.id) {
    out.push(
      toRecommendation(
        'balanced',
        'Best balance',
        balanced,
        candidate,
        'Full quality at a sane file size.',
      ),
    );
  }
  if (
    smallest &&
    smallest.variant.id !== best.variant.id &&
    smallest.variant.id !== balanced.variant.id
  ) {
    out.push(
      toRecommendation(
        'smallest',
        'Smallest file',
        smallest,
        candidate,
        'Least data, lowest quality.',
      ),
    );
  }
  return out;
}

/**
 * The rendition "best" means for one candidate (D20), and the audio that goes
 * with it when the stream is split. Undefined when the candidate has no
 * renditions, or none that can be saved.
 */
export function bestRenditionOf(candidate: MediaCandidate): Rendition | undefined {
  const [best] = rankRenditions(candidate, saveablePool(candidate), saveableAudio(candidate));
  if (!best) return undefined;
  return best.audio ? { variant: best.variant, audio: best.audio } : { variant: best.variant };
}

/**
 * The rendition a download fetches when nobody picked one
 * (downloads/task-factory.ts `renditionToFetch`): the same rule as "Best
 * download". Undefined for a direct file, which has no renditions.
 *
 * When no rendition can be saved it still names the one the rule would pick,
 * so a download asked for anyway fails for that rendition's own reason
 * rather than for having nothing to fetch.
 *
 * Never `variants[0]` alone: manifests list renditions in whatever order the
 * packager chose, and many put the lowest rung first.
 */
export function bestVariantOf(candidate: MediaCandidate): MediaVariant | undefined {
  return (
    bestRenditionOf(candidate)?.variant ??
    rankRenditions(candidate, downloadPool(candidate.variants ?? []), audioOf(candidate))[0]
      ?.variant
  );
}

/**
 * What "Best download" means everywhere - the popup's primary button, the
 * keyboard shortcut and the context menu: the highest-ranked candidate that
 * can be saved, in its best rendition, with the audio track to download next
 * to it when the stream only exists as separate video and audio. Candidates
 * arrive ranked best-first; one whose renditions are all unsaveable is passed
 * over for the next.
 */
export function pickBestDownload(candidates: MediaCandidate[]): BestDownload | undefined {
  for (const candidate of candidates) {
    if (!isSaveable(saveabilityOf(candidate))) continue;
    if ((candidate.variants?.length ?? 0) === 0) return { candidate };
    const best = bestRenditionOf(candidate);
    if (best) return { candidate, ...best };
  }
  return undefined;
}

/** A rendition with what the rule weighs: its paired audio, its quality score and its size. */
interface Evaluated {
  variant: MediaVariant;
  audio?: MediaVariant | undefined;
  score: number;
  sizeBytes?: number | undefined;
}

/**
 * "Best" as a written rule (ARCHITECTURE.md D20). Between two renditions of
 * one media, the first difference decides:
 *
 *   1. sound       a rendition that carries its own audio beats a video-only one
 *   2. resolution  the ladder rung, so a 1918x1076 encode is the 1080p it is labelled
 *   3. bitrate     average where the manifest gives it, else peak
 *   4. quality     the combined score: codec, frame rate, and the paired audio
 *
 * Without a muxer the tallest rendition is often a silent one, and a person
 * who asks for "the best version" wants to watch it with sound. Negative when
 * `a` is the better one.
 */
function compareRenditions(a: Evaluated, b: Evaluated): number {
  return (
    Number(b.variant.tracks.audio) - Number(a.variant.tracks.audio) ||
    rungHeightOf(b.variant) - rungHeightOf(a.variant) ||
    bandwidthOf(b.variant) - bandwidthOf(a.variant) ||
    b.score - a.score
  );
}

/** The pool, best first by the D20 rule. A stable sort, so a full tie keeps the listed order. */
function rankRenditions(
  candidate: MediaCandidate,
  pool: MediaVariant[],
  audioTracks: MediaVariant[],
): Evaluated[] {
  return pool
    .map((variant) => evaluate(variant, audioTracks, candidate.duration))
    .sort(compareRenditions);
}

/**
 * What "best" chooses among, out of a candidate's `variants`: the video
 * renditions, or for an audio-only stream its audio renditions. Every one, not
 * one per rung: two renditions on one rung can differ in whether they carry
 * sound.
 *
 * The scan decides a row's saveability from this same pool
 * (detection/saveability.ts): an audio-only variant that fits does not make a
 * ladder saveable when "best" would never pick it.
 */
export function downloadPool(variants: MediaVariant[]): MediaVariant[] {
  const video = variants.filter((variant) => variant.tracks.video);
  if (video.length > 0) return video;
  const audio = audioLadder(variants);
  return audio.length > 0 ? audio : variants;
}

function saveablePool(candidate: MediaCandidate): MediaVariant[] {
  return downloadPool(candidate.variants ?? []).filter((variant) =>
    isSaveable(renditionSaveability(candidate, variant)),
  );
}

/** The separate audio tracks a video-only rendition can be paired with. */
function audioOf(candidate: MediaCandidate): MediaVariant[] {
  return candidate.audioTracks ?? audioLadder(candidate.variants ?? []);
}

/** Only an audio track that can be saved is worth pairing: "best" downloads it. */
function saveableAudio(candidate: MediaCandidate): MediaVariant[] {
  return audioOf(candidate).filter((track) => isSaveable(renditionSaveability(candidate, track)));
}

function evaluate(
  variant: MediaVariant,
  audioTracks: MediaVariant[],
  duration: number | undefined,
): Evaluated {
  const audio = pairAudioFor(variant, audioTracks);
  const audioCodec = audio?.codecs?.[0] ?? variant.codecs?.find((c) => isAudioCodec(c));
  const score = qualityScore({
    ...(variant.resolution ? { height: equivalentHeight(variant.resolution) } : {}),
    ...(variant.bandwidth !== undefined ? { bitrate: variant.bandwidth } : {}),
    ...(variant.fps !== undefined ? { fps: variant.fps } : {}),
    ...(variant.codecs ? { codecs: variant.codecs } : {}),
    ...(audio?.bandwidth !== undefined ? { audioBitrate: audio.bandwidth } : {}),
    ...(audioCodec ? { audioCodec } : {}),
  });
  return { variant, audio, score, sizeBytes: estimatedBytes(variant, duration) };
}

function toRecommendation(
  kind: RecommendationKind,
  label: string,
  entry: {
    variant: MediaVariant;
    audio?: MediaVariant | undefined;
    sizeBytes?: number | undefined;
  },
  candidate: MediaCandidate,
  reason: string,
): Recommendation {
  const estimated = entry.variant.sizeEstimated !== false;
  return {
    kind,
    label,
    variant: entry.variant,
    ...(entry.audio ? { audio: entry.audio } : {}),
    ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
    sizeEstimated:
      entry.sizeBytes !== undefined ? estimated || candidate.sizeEstimated !== false : true,
    reason,
  };
}

/**
 * The bytes one rendition's file will take: the size the manifest states, or
 * its bitrate x the duration. The average bitrate where the manifest gives
 * one (HLS AVERAGE-BANDWIDTH), since the peak over-states a whole file. The
 * one estimate the row shows and the scan's "too large" check uses
 * (detection/saveability.ts), so the two never disagree.
 */
export function estimatedBytes(
  variant: MediaVariant,
  duration: number | undefined,
): number | undefined {
  return isPositive(variant.sizeBytes)
    ? variant.sizeBytes
    : estimate(bandwidthOf(variant), duration);
}

/** Bytes from bitrate x duration. Undefined unless both are real positive numbers. */
function estimate(bandwidth: number | undefined, duration: number | undefined): number | undefined {
  if (!isPositive(bandwidth) || !isPositive(duration)) return undefined;
  return Math.round((bandwidth / 8) * duration);
}

function isPositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function scoreOf(variant: MediaVariant): number {
  return variant.score ?? bandwidthOf(variant);
}

function heightOf(variant: MediaVariant): number {
  return variant.resolution ? equivalentHeight(variant.resolution) : 0;
}

/** The rung a rendition is labelled with; 0 without a resolution, so any picture beats none. */
function rungHeightOf(variant: MediaVariant): number {
  return variant.resolution ? rungOf(variant.resolution).height : 0;
}

function bandwidthOf(variant: MediaVariant): number {
  return variant.averageBandwidth ?? variant.bandwidth ?? 0;
}

/** Human-readable byte size. Binary units, one decimal above MB. */
export function formatBytes(bytes: number | undefined, estimated = false): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  const prefix = estimated ? '~' : '';
  if (bytes < 1024) return `${prefix}${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${prefix}${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${prefix}${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${prefix}${(mb / 1024).toFixed(2)} GB`;
}

/** Seconds to h:mm:ss / m:ss. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
