/**
 * Builds the segment plan for a chosen rendition, at download time.
 *
 * The plan is rebuilt from the manifest rather than cached from the scan on
 * purpose: an MV3 service worker is killed between the scan and the download
 * often enough that a cache would be a source of "works on my machine" bugs,
 * and manifests for live content change underneath you anyway.
 */

import { ErrorCode, MediaGrabError } from '../core/errors.ts';
import { fetchManifestText, MANIFEST_TIMEOUT_MS } from '../core/fetch.ts';
import type { MediaCandidate, MediaVariant } from '../core/types.ts';
import { dashContainer, downloadablePeriod, parseDashManifest } from '../manifests/dash/parse.ts';
import { buildSegmentPlan } from '../manifests/dash/segments.ts';
import { parseHlsPlaylist } from '../manifests/hls/parse.ts';
import { buildHlsSegmentPlan, hlsContainer } from '../manifests/hls/segments.ts';
import type { SegmentContainer, SegmentPlan } from '../manifests/segment-plan.ts';

export interface PlanOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** The segments to fetch, and what joining them produces. */
export interface PlannedDownload {
  plan: SegmentPlan;
  container: SegmentContainer;
}

/**
 * Why a live stream is refused, whichever protocol carries it. A live
 * manifest lists only the window of segments the server keeps right now, so
 * a plan built from it saves a few seconds or minutes of the middle and calls
 * it done. The scan says "live" before the click (detection/saveability.ts);
 * this is the same "no" at download time, for a stream the scan could not
 * decide.
 */
const LIVE_REFUSAL = 'This is a live stream with no end yet. MediaGrab downloads finished videos.';

function fetchText(url: string, options: PlanOptions): Promise<string> {
  return fetchManifestText(url, {
    timeoutMs: MANIFEST_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

export async function buildPlanForVariant(
  candidate: MediaCandidate,
  variant: MediaVariant,
  options: PlanOptions = {},
): Promise<PlannedDownload> {
  if (variant.protocol === 'hls') return buildHlsPlan(variant, options);
  if (variant.protocol === 'dash') return buildDashPlan(candidate, variant, options);
  throw new MediaGrabError(
    ErrorCode.UNSUPPORTED_MANIFEST,
    `Cannot build a segment plan for protocol "${variant.protocol}"`,
  );
}

async function buildHlsPlan(variant: MediaVariant, options: PlanOptions): Promise<PlannedDownload> {
  const playlist = parseHlsPlaylist(await fetchText(variant.url, options));

  if (playlist.kind !== 'media') {
    throw new MediaGrabError(
      ErrorCode.UNSUPPORTED_MANIFEST,
      'Expected a media playlist, got another master playlist',
    );
  }
  if (playlist.drm) {
    throw new MediaGrabError(
      ErrorCode.DRM_PROTECTED,
      `This stream is protected by ${playlist.drmSystems[0] ?? 'DRM'}`,
    );
  }
  if (playlist.live) {
    // No EXT-X-ENDLIST and no VOD type: the playlist is still being written.
    // Checked in the scan's order (DRM, then live), so both give one reason.
    throw new MediaGrabError(ErrorCode.UNSUPPORTED_MANIFEST, LIVE_REFUSAL);
  }
  if (playlist.encrypted) {
    // Plain AES-128 is not DRM, but this build does not decrypt, and encrypted
    // segments written to disk are an unplayable file. Saying so beats shipping it.
    throw new MediaGrabError(
      ErrorCode.UNSUPPORTED_MANIFEST,
      'This stream is AES-encrypted. MediaGrab does not decrypt encrypted streams.',
    );
  }
  if (playlist.iframesOnly) {
    throw new MediaGrabError(
      ErrorCode.INVALID_MEDIA,
      'This playlist contains only trick-play frames',
    );
  }

  return {
    plan: buildHlsSegmentPlan(playlist, variant.url, variant.bandwidth),
    container: hlsContainer(playlist),
  };
}

async function buildDashPlan(
  candidate: MediaCandidate,
  variant: MediaVariant,
  options: PlanOptions,
): Promise<PlannedDownload> {
  const manifest = parseDashManifest(await fetchText(candidate.url, options), candidate.url);

  if (manifest.drm) {
    throw new MediaGrabError(
      ErrorCode.DRM_PROTECTED,
      `This stream is protected by ${manifest.drmSystems[0] ?? 'DRM'}`,
    );
  }

  if (manifest.live) {
    // A dynamic MPD: a SegmentTimeline lists only the window the server
    // keeps, so building from it would save a slice and call it the video.
    throw new MediaGrabError(ErrorCode.UNSUPPORTED_MANIFEST, LIVE_REFUSAL);
  }

  const period = downloadablePeriod(manifest);

  const representation = period.representations.find(
    (rep) =>
      rep.id === variant.dashRepresentationId &&
      rep.adaptationSetId === variant.dashAdaptationSetId,
  );
  if (!representation) {
    throw new MediaGrabError(
      ErrorCode.STREAM_EXPIRED,
      'That quality is no longer in the manifest. Scan the page again.',
    );
  }

  const plan = buildSegmentPlan(representation, {
    ...(period.duration !== undefined ? { periodDuration: period.duration } : {}),
    live: manifest.live,
  });

  if (plan.segments.length === 0) {
    throw new MediaGrabError(
      ErrorCode.UNSUPPORTED_MANIFEST,
      'MediaGrab cannot work out the segments of this quality from its manifest.',
    );
  }

  return { plan, container: dashContainer(representation) };
}
