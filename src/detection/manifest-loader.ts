/**
 * Fetches an HLS or DASH manifest and reads the quality ladder out of it.
 *
 *   loadManifestDetails(url)  fetch + parse -> what the manifest says (pure data)
 *   withManifestDetails(candidate, details)  attach it to a candidate
 *
 * Split so the scanner can remember the details of a manifest it fetched a
 * moment ago (detection/manifest-cache.ts) - a busy page triggers scans in
 * bursts, and the manifest does not change between them.
 *
 * Runs in the background worker, which is the only context with host
 * permissions for cross-origin manifest fetches. The fetch itself (no
 * credentials, timeout, size cap, error classification) is `fetchManifestText`.
 *
 * Besides the ladder, a manifest says things that decide whether it can be
 * saved at all (ARCHITECTURE.md D21) but that are not the candidate's to
 * carry: its encryption, its segment count, its Periods. Those travel as
 * `facts`, which detection/saveability.ts reads and `withManifestDetails`
 * leaves off the candidate.
 */
import { ErrorCode, MediaGrabError } from '../core/errors.ts';
import { fetchManifestText, MANIFEST_TIMEOUT_MS } from '../core/fetch.ts';
import { createLogger } from '../core/log.ts';
import type { MediaCandidate, MediaVariant, SubtitleTrack, TrackFlags } from '../core/types.ts';
import type { DashRepresentation } from '../manifests/dash/model.ts';
import {
  dashContainer,
  firstPeriod,
  looksLikeDash,
  parseDashManifest,
} from '../manifests/dash/parse.ts';
import { countSegments } from '../manifests/dash/segments.ts';
import {
  type HlsMasterPlaylist,
  type HlsMediaPlaylist,
  type HlsStreamInf,
  looksLikeHls,
  parseHlsPlaylist,
} from '../manifests/hls/parse.ts';
import { hlsContainer } from '../manifests/hls/segments.ts';
import type { SegmentContainer } from '../manifests/segment-plan.ts';
import { resolveUrl } from '../manifests/url.ts';
import { hashString, normalizeUrl } from '../media/fingerprint.ts';
import { guessFormat, tracksFromCodecs } from '../media/format.ts';
import { equivalentHeight } from '../media/quality.ts';
import { qualityScore } from '../media/score.ts';

const log = createLogger('manifest');

export interface LoadOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** What a manifest adds to the candidate that points at it. */
export type ManifestDetails = Pick<MediaCandidate, 'protocol' | 'variants'> &
  Partial<
    Pick<
      MediaCandidate,
      'kind' | 'audioTracks' | 'subtitles' | 'duration' | 'live' | 'drm' | 'drmSystem'
    >
  > & { facts?: StreamFacts };

/**
 * What the manifest says about saving it, beyond the candidate's own fields
 * (`live`, `drm` and `duration` are those). Read by detection/saveability.ts.
 */
export type StreamFacts = HlsMasterFacts | HlsMediaFacts | DashFacts;

export interface HlsMasterFacts {
  document: 'hls-master';
}

/**
 * An HLS media playlist: found on its own, or fetched during the scan as the
 * best rendition of a master (detection/engine.ts), since a master says
 * nothing about its segments.
 */
export interface HlsMediaFacts {
  document: 'hls-media';
  /** Some EXT-X-KEY encrypts segments. Plain AES-128 included: it is not DRM, but it is not saved either. */
  encrypted: boolean;
  /** EXT-X-I-FRAMES-ONLY: trick-play frames, nothing to watch. */
  iframesOnly: boolean;
  /** Segments a download would fetch (gaps are never fetched). */
  segmentCount: number;
  /** What the segments join into (fMP4 when there is an EXT-X-MAP). */
  container: SegmentContainer;
}

export interface DashFacts {
  document: 'dash';
  /** More than one is refused at download time (manifests/dash/parse.ts `downloadablePeriod`). */
  periods: number;
}

/** Throws MediaGrabError for anything that is not a manifest we can read. */
export async function loadManifestDetails(
  url: string,
  hint: MediaCandidate['protocol'],
  options: LoadOptions = {},
): Promise<ManifestDetails> {
  const text = await fetchManifestText(url, {
    timeoutMs: MANIFEST_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (hint === 'dash' || looksLikeDash(text)) return dashDetails(text, url);
  if (hint === 'hls' || looksLikeHls(text)) return hlsDetails(text, url);
  throw new MediaGrabError(
    ErrorCode.UNSUPPORTED_MANIFEST,
    'Response is neither an HLS playlist nor a DASH manifest',
  );
}

/**
 * The candidate, with everything its manifest says. The id is kept, so it
 * lines up with the scan. The facts stay behind: they are the scan's to read,
 * not the candidate's to carry into storage.
 */
export function withManifestDetails(
  candidate: MediaCandidate,
  details: ManifestDetails,
): MediaCandidate {
  const { facts: _facts, ...fields } = details;
  return { ...candidate, ...fields };
}

// ─── HLS ─────────────────────────────────────────────────────────────────────

function hlsDetails(text: string, url: string): ManifestDetails {
  const playlist = parseHlsPlaylist(text);
  const drm = {
    drm: playlist.drm,
    ...(playlist.drmSystems[0] ? { drmSystem: playlist.drmSystems[0] } : {}),
  };

  if (playlist.kind === 'media') {
    // Found on its own, with no master above it: one rendition, no ladder.
    // The download treats the playlist as its own rendition (task-factory.ts).
    return {
      protocol: 'hls',
      variants: [],
      ...(playlist.totalDuration > 0 ? { duration: playlist.totalDuration } : {}),
      live: playlist.live,
      ...drm,
      facts: mediaPlaylistFacts(playlist),
    };
  }

  const variants = playlist.variants.map((stream, index) =>
    hlsVariant(stream, index, url, playlist),
  );
  const audioTracks = playlist.renditions
    .filter((rendition) => rendition.type === 'AUDIO' && rendition.uri)
    .map(
      (rendition, index): MediaVariant => ({
        id: hashString(`${rendition.uri}|audio|${index}`),
        url: resolveUrl(rendition.uri as string, url) ?? (rendition.uri as string),
        kind: 'audio',
        protocol: 'hls',
        format: 'ts',
        tracks: { video: false, audio: true },
        audioGroupId: rendition.groupId,
        ...(rendition.language ? { language: rendition.language } : {}),
        label: rendition.name,
        default: rendition.default,
        // The same role DASH writes, so one pairing rule serves both (D20).
        ...(rendition.describesVideo ? { role: 'description' } : {}),
      }),
    );
  const subtitles = playlist.renditions
    .filter((rendition) => rendition.type === 'SUBTITLES' && rendition.uri)
    .map(
      (rendition, index): SubtitleTrack => ({
        id: hashString(`${rendition.uri}|sub|${index}`),
        url: resolveUrl(rendition.uri as string, url) ?? (rendition.uri as string),
        format: 'vtt',
        ...(rendition.language ? { language: rendition.language } : {}),
        label: rendition.name,
        forced: rendition.forced,
        default: rendition.default,
      }),
    );

  log.debug('expanded HLS master', { variants: variants.length, audio: audioTracks.length });
  // A master playlist has no duration of its own; the download rebuilds the
  // chosen rendition's media playlist, which does.
  return {
    protocol: 'hls',
    kind: variants.some((variant) => variant.tracks.video) ? 'video' : 'audio',
    variants,
    ...(audioTracks.length > 0 ? { audioTracks } : {}),
    ...(subtitles.length > 0 ? { subtitles } : {}),
    ...drm,
    facts: { document: 'hls-master' },
  };
}

function mediaPlaylistFacts(playlist: HlsMediaPlaylist): HlsMediaFacts {
  return {
    document: 'hls-media',
    encrypted: playlist.encrypted,
    iframesOnly: playlist.iframesOnly,
    segmentCount: playlist.segments.filter((segment) => !segment.gap).length,
    container: hlsContainer(playlist),
  };
}

function hlsVariant(
  stream: HlsStreamInf,
  index: number,
  masterUrl: string,
  playlist: HlsMasterPlaylist,
): MediaVariant {
  const url = resolveUrl(stream.uri, masterUrl) ?? stream.uri;
  const tracks = hlsVariantTracks(stream, playlist);
  return {
    // Ids survive a rescan with fresh signatures: the URL is hashed normalized.
    id: hashString(`${normalizeUrl(url)}|${index}`),
    url,
    kind: tracks.video ? 'video' : 'audio',
    protocol: 'hls',
    format: 'ts',
    bandwidth: stream.bandwidth,
    ...(stream.averageBandwidth !== undefined ? { averageBandwidth: stream.averageBandwidth } : {}),
    ...(stream.resolution ? { resolution: stream.resolution } : {}),
    ...(stream.frameRate !== undefined ? { fps: stream.frameRate } : {}),
    ...(stream.codecs ? { codecs: stream.codecs } : {}),
    tracks,
    ...(stream.audioGroupId ? { audioGroupId: stream.audioGroupId } : {}),
    ...(stream.subtitleGroupId ? { subtitleGroupId: stream.subtitleGroupId } : {}),
    score: qualityScore({
      ...(stream.resolution ? { height: equivalentHeight(stream.resolution) } : {}),
      bitrate: stream.bandwidth,
      ...(stream.frameRate !== undefined ? { fps: stream.frameRate } : {}),
      ...(stream.codecs ? { codecs: stream.codecs } : {}),
    }),
  };
}

/**
 * What the variant's own playlist carries - which is what a download of it saves.
 *
 *  - CODECS lists every format in the presentation, audio included, even when
 *    the audio lives in a separate rendition (RFC 8216 s4.3.4.2). So when the
 *    variant's AUDIO group has renditions with their own URI, the audio is NOT
 *    in this variant's segments (s4.3.4.2.1), whatever CODECS says.
 *  - Without CODECS, an old-style master (BANDWIDTH only, as Apple's own
 *    early examples) is muxed audio and video - the only kind that existed.
 */
function hlsVariantTracks(stream: HlsStreamInf, playlist: HlsMasterPlaylist): TrackFlags {
  const audioElsewhere =
    stream.audioGroupId !== undefined &&
    playlist.renditions.some(
      (rendition) =>
        rendition.type === 'AUDIO' && rendition.groupId === stream.audioGroupId && rendition.uri,
    );
  const declared = tracksFromCodecs(stream.codecs);
  if (declared) return { video: declared.video, audio: declared.audio && !audioElsewhere };
  return { video: true, audio: !audioElsewhere };
}

// ─── DASH ────────────────────────────────────────────────────────────────────

function dashDetails(text: string, mpdUrl: string): ManifestDetails {
  const manifest = parseDashManifest(text, mpdUrl);
  // The ladder is read from the first Period; a multi-Period MPD is refused at
  // download time (plan-builder.ts) rather than saved cut short.
  const period = firstPeriod(manifest);

  // A single-file representation is offered as a plain file only when the MPD
  // is one Period: otherwise that file is just the first part (often an
  // advert), and the segmented path refuses the stream as a whole.
  const singlePeriod = manifest.periods.length === 1;
  // Counted as the download will build them (plan-builder.ts), so a
  // representation it would refuse is known before the click.
  const plan = {
    ...(period.duration !== undefined ? { periodDuration: period.duration } : {}),
    live: manifest.live,
  };
  const videos: MediaVariant[] = [];
  const audios: MediaVariant[] = [];
  const subtitles: SubtitleTrack[] = [];
  for (const rep of period.representations) {
    if (rep.contentType === 'text') {
      // Only a single-file text track has a URL of its own; a segmented one
      // (template or list) has a directory as its BaseURL, not a file.
      if (rep.addressing === 'base') subtitles.push(dashSubtitle(rep));
    } else if (rep.addressing === 'unknown') {
      // Nothing MediaGrab can enumerate: offering it would only fail later.
    } else if (rep.contentType === 'video' || rep.contentType === 'audio') {
      const variant = dashVariant(rep, mpdUrl, singlePeriod);
      if (variant.protocol === 'dash') variant.segmentCount = countSegments(rep, plan);
      (rep.contentType === 'video' ? videos : audios).push(variant);
    }
    // 'image' (thumbnail tiles) and unknown content types are not downloads.
  }

  log.debug('expanded DASH manifest', { video: videos.length, audio: audios.length });
  return {
    protocol: 'dash',
    kind: videos.length > 0 ? 'video' : 'audio',
    ...(manifest.duration !== undefined ? { duration: manifest.duration } : {}),
    live: manifest.live,
    drm: manifest.drm,
    ...(manifest.drmSystems[0] ? { drmSystem: manifest.drmSystems[0] } : {}),
    variants: videos.length > 0 ? videos : audios,
    ...(audios.length > 0 ? { audioTracks: audios } : {}),
    ...(subtitles.length > 0 ? { subtitles } : {}),
    facts: { document: 'dash', periods: manifest.periods.length },
  };
}

/**
 * One representation as a downloadable rendition. A single-file one
 * (SegmentBase, or a bare BaseURL) is a complete MP4 at its BaseURL, so it is
 * offered as a plain file: the browser streams it to disk, can pause and
 * resume it, and needs no segment assembly in memory.
 */
function dashVariant(rep: DashRepresentation, mpdUrl: string, singlePeriod: boolean): MediaVariant {
  const singleFile = rep.addressing === 'base' && singlePeriod;
  const video = rep.contentType === 'video';
  return {
    id: hashString(`${normalizeUrl(mpdUrl)}|${rep.adaptationSetId}|${rep.id}`),
    url: singleFile ? rep.baseUrl : mpdUrl,
    kind: video ? 'video' : 'audio',
    protocol: singleFile ? 'progressive' : 'dash',
    format: dashContainer(rep) === 'webm' ? 'webm' : video ? 'mp4' : 'm4a',
    ...(rep.bandwidth !== undefined ? { bandwidth: rep.bandwidth } : {}),
    ...(rep.width !== undefined && rep.height !== undefined
      ? { resolution: { width: rep.width, height: rep.height } }
      : {}),
    ...(rep.frameRate !== undefined ? { fps: rep.frameRate } : {}),
    ...(rep.codecs ? { codecs: rep.codecs } : {}),
    // A DASH representation carries one media type; muxed ones are vanishingly rare.
    tracks: { video, audio: !video },
    ...(rep.language ? { language: rep.language } : {}),
    ...(rep.label ? { label: rep.label } : {}),
    // The Role says which audio is the programme's own sound: "main" is DASH's
    // HLS DEFAULT=YES, and "description" or "commentary" must not be what
    // "best" pairs with the picture just for its higher bitrate (D20).
    ...(!video && rep.role ? { role: rep.role } : {}),
    ...(!video && rep.role === 'main' ? { default: true } : {}),
    dashRepresentationId: rep.id,
    dashAdaptationSetId: rep.adaptationSetId,
    ...(rep.sizeBytes !== undefined ? { sizeBytes: rep.sizeBytes, sizeEstimated: true } : {}),
    score: qualityScore({
      ...(rep.width !== undefined && rep.height !== undefined
        ? { height: equivalentHeight({ width: rep.width, height: rep.height }) }
        : {}),
      ...(rep.bandwidth !== undefined ? { bitrate: rep.bandwidth } : {}),
      ...(rep.frameRate !== undefined ? { fps: rep.frameRate } : {}),
      ...(rep.codecs ? { codecs: rep.codecs } : {}),
      ...(rep.audioChannels !== undefined ? { audioChannels: rep.audioChannels } : {}),
    }),
  };
}

function dashSubtitle(rep: DashRepresentation): SubtitleTrack {
  return {
    id: hashString(`${rep.baseUrl}|${rep.id}`),
    url: rep.baseUrl,
    format: guessFormat(rep.baseUrl, rep.mimeType).format === 'ttml' ? 'ttml' : 'vtt',
    ...(rep.language ? { language: rep.language } : {}),
    ...(rep.label ? { label: rep.label } : {}),
    forced: rep.role === 'forced-subtitle',
  };
}
