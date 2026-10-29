/**
 * "Why can't I download this?" (PRD s20).
 *
 * A downloader that says "No video found" teaches the user nothing and
 * generates a support request. This module turns the signals we already
 * collected into the most likely explanation, ordered by how often it is the
 * real one.
 */
import type { Diagnosis, MediaCandidate, PageSignals, ScanStats } from '../core/types.ts';

/**
 * Fewer requests than this since the page began, with a player on it, means
 * playback has not started: a playing video fetches a manifest and segments
 * within seconds, while a page that has merely loaded fetched only its assets.
 */
const STARTED_PLAYBACK_REQUESTS = 5;

/**
 * The most likely reason nothing on the page can be downloaded, or undefined
 * when something can. Checked in order of how often each is the real one.
 */
export function diagnose(
  candidates: MediaCandidate[],
  stats: ScanStats,
  signals: PageSignals,
): Diagnosis | undefined {
  if (candidates.some((candidate) => candidate.drm !== true)) return undefined;

  if (signals.hasMediaKeys || candidates.some((candidate) => candidate.drm === true)) {
    return {
      code: 'DRM_PROTECTED',
      reasons: [
        'The player is using DRM (a licence from the site) for this media.',
        'MediaGrab does not remove DRM, so this download is not possible.',
      ],
    };
  }

  if (signals.hasMediaSource) {
    return {
      code: 'MSE_ONLY',
      reasons: [
        'The player builds the video in JavaScript (Media Source Extensions), so there is no single file to fetch.',
        'The underlying manifest is usually visible once playback starts - press play, then scan again.',
        'If the site delivers segments without a manifest, MediaGrab cannot reassemble them.',
      ],
    };
  }

  if (signals.mediaElements > 0 && stats.networkRequestsObserved < STARTED_PLAYBACK_REQUESTS) {
    return {
      code: 'NOT_STARTED',
      reasons: [
        'A player is on the page but it has not requested any media yet.',
        'Start playback, then scan again.',
      ],
    };
  }

  if (signals.playerFrames > 0 && signals.mediaElements === 0) {
    return {
      code: 'CROSS_ORIGIN_FRAME',
      reasons: [
        `The video plays inside ${signals.playerFrames} embedded player(s) from another site.`,
        'Grant MediaGrab access to that site, or open the video in its own tab and scan there.',
      ],
    };
  }

  // Something media-like was found, but all of it scored too low to show (an
  // advert, a thumbnail, a manifest that would not open). `candidates` holds
  // only what is shown, so it is empty here.
  if (stats.candidatesAfterDedupe > 0) {
    return {
      code: 'UNSUPPORTED_PLAYER',
      reasons: [
        'Media-like requests were seen, but none of them looked like the video on this page.',
        'This usually means a custom player format. Reporting the site helps us add support.',
      ],
    };
  }

  return {
    code: 'NO_MEDIA_YET',
    reasons: [
      'No media has been requested by this page yet.',
      'Many sites only load the video after you press play, scroll to it, or open a modal.',
      'Press play and scan again.',
    ],
  };
}

/** Copy for the popup's diagnosis panel. */
export const DIAGNOSIS_TITLES: Record<Diagnosis['code'], string> = {
  NO_MEDIA_YET: 'Nothing to download yet',
  DRM_PROTECTED: 'Protected content',
  MSE_ONLY: 'The player streams this in pieces',
  CROSS_ORIGIN_FRAME: 'The media lives in an embedded frame',
  NOT_STARTED: 'Playback has not started',
  UNSUPPORTED_PLAYER: 'Unrecognised player',
};
