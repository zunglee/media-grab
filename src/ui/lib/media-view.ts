/**
 * What the media list says next to a download button: warnings about what the
 * file will be, and the reason a row or a rendition cannot be saved (D21).
 */
import type { MediaCandidate, MediaVariant, Saveability } from '../../core/types.ts';
import { bestVariantOf } from '../../media/quality.ts';
import { renditionSaveability, saveabilityOf } from '../../media/saveability.ts';

export const NO_SOUND = 'video only — no sound';

/**
 * "Best" on a stream that only exists as separate video and audio saves both
 * (ARCHITECTURE.md D20): two files, since MediaGrab does not mux.
 */
export const SEPARATE_FILES = 'video and audio as separate files';

/**
 * A rendition with a picture and no audio track: a DASH video representation,
 * or an HLS variant whose audio is a separate rendition. MediaGrab does not mux
 * (ARCHITECTURE.md s5), so downloading it gives a silent file, and the button
 * has to say so before the click rather than after.
 */
export function lacksSound(variant: MediaVariant | undefined): boolean {
  return variant?.tracks.video === true && variant.tracks.audio === false;
}

/**
 * What a download button warns about: the audio arriving as a second file,
 * or not at all. Null when the file is simply the video, with its sound.
 */
export function soundNote(
  pick: { variant?: MediaVariant | undefined; audio?: MediaVariant | undefined } | undefined,
): string | null {
  if (pick?.audio) return SEPARATE_FILES;
  return lacksSound(pick?.variant) ? NO_SOUND : null;
}

/** Why it cannot be saved, in one plain line. Each mirrors the refusal the download would give. */
const UNSAVEABLE: Record<Exclude<Saveability, 'saveable'>, string> = {
  drm: 'Protected content. MediaGrab does not remove DRM.',
  encrypted: 'Encrypted stream. MediaGrab does not decrypt, so the file would not play.',
  live: 'Live stream. MediaGrab saves finished videos, not live broadcasts.',
  'multi-period': 'Made of separate parts (often adverts) that cannot be joined into one file.',
  'media-source': "Assembled by the page's player, so there is no file to fetch.",
  'too-large': 'Too large to assemble in the browser.',
  'no-rendition': 'This stream lists nothing MediaGrab can download.',
};

/** The line a disabled row or rendition shows; null when it can be saved (or nothing was decided). */
export function unsaveableReason(status: Saveability | undefined): string | null {
  return status === undefined || status === 'saveable' ? null : UNSAVEABLE[status];
}

/**
 * Why a row's main button must not download, though the row lists a ladder:
 * "best" found nothing in it that can be saved (`best` is `recommend()[0]`,
 * absent then). Null when the button can download.
 *
 * The scan sees to it that such a row is refused as a whole
 * (detection/saveability.ts judges it by the pool "best" draws from), so this
 * is the second line: if the two ever drift, clicking would queue the very
 * rendition "best" passed over and fail for a reason the row already knew. The
 * reason given is that rendition's own.
 */
export function mainDownloadBlock(
  candidate: MediaCandidate,
  best: { variant: MediaVariant } | undefined,
): string | null {
  if (best || (candidate.variants?.length ?? 0) === 0) return null;
  const passedOver = bestVariantOf(candidate);
  const status = passedOver ? renditionSaveability(candidate, passedOver) : undefined;
  return unsaveableReason(status) ?? UNSAVEABLE['no-rendition'];
}

/**
 * What the popup says when "Best download" has nothing to take. Everything
 * protected keeps its own sentence (users ask about DRM by name); any other
 * mix sends them to the rows, which each say why.
 */
export function nothingSaveableHint(candidates: MediaCandidate[]): string {
  return candidates.length > 0 && candidates.every((c) => saveabilityOf(c) === 'drm')
    ? 'Everything found here is protected, so there is nothing to download.'
    : 'Nothing found here can be downloaded. Each item says why.';
}
