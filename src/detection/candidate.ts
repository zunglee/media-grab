/**
 * Building a MediaCandidate: the one place protocol, format, tracks and the id
 * are derived, whichever detector found the URL.
 *
 * The network observer builds candidates from what the browser tells it. A
 * content script, by contrast, runs inside the page, so what it sends is a
 * claim (`ReportedCandidate`, already allow-listed by core/messages.ts). The
 * worker rebuilds that claim here rather than storing a page-built object, so
 * a page can never pre-set variants, a score or a DRM verdict.
 */
import type { ReportedCandidate } from '../core/messages.ts';
import type { MediaCandidate, MediaKind, TrackFlags } from '../core/types.ts';
import { fingerprintCandidate } from '../media/fingerprint.ts';
import { guessFormat } from '../media/format.ts';

export type CandidateInput = Omit<
  MediaCandidate,
  'id' | 'seenAt' | 'protocol' | 'format' | 'tracks'
> &
  Partial<Pick<MediaCandidate, 'protocol' | 'format' | 'tracks'>>;

/** Fill in format, protocol and tracks from the URL and MIME type, then fingerprint. */
export function makeCandidate(input: CandidateInput): MediaCandidate {
  const guess = guessFormat(input.url, input.mimeType);
  const kind = input.kind === 'unknown' ? guess.kind : input.kind;
  const base: Omit<MediaCandidate, 'id'> = {
    ...input,
    kind,
    protocol: input.protocol ?? guess.protocol,
    format: input.format ?? guess.format,
    tracks: input.tracks ?? defaultTracks(kind),
    seenAt: Date.now(),
  };
  return { ...base, id: fingerprintCandidate(base) };
}

/** Where a report came from: the page it describes and the frame that sent it. */
export interface ReportOrigin {
  pageUrl: string;
  pageTitle: string;
  frameId: number;
}

export function candidateFromReport(
  reported: ReportedCandidate,
  origin: ReportOrigin,
): MediaCandidate {
  const { subtitles, ...claim } = reported;
  return makeCandidate({
    ...claim,
    pageUrl: origin.pageUrl,
    pageTitle: origin.pageTitle,
    frameId: origin.frameId,
    ...(subtitles
      ? {
          subtitles: subtitles.map((track) => ({
            ...track,
            id: track.url,
            format: guessFormat(track.url).format === 'ttml' ? 'ttml' : 'vtt',
          })),
        }
      : {}),
  });
}

/** Until a manifest or the codecs say otherwise, a video has sound and an audio file has no picture. */
function defaultTracks(kind: MediaKind): TrackFlags {
  if (kind === 'video') return { video: true, audio: true };
  if (kind === 'audio') return { video: false, audio: true };
  return { video: false, audio: false };
}
