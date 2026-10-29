/**
 * Compile a parsed HLS media playlist into the engine's segment plan.
 *
 *   URIs          resolved against the playlist's own URL (RFC 8216 s4.1)
 *   EXT-X-BYTERANGE  becomes a Range request; without an offset it continues
 *                 from the end of the previous sub-range of the same resource
 *                 (s4.3.2.2)
 *   EXT-X-GAP     skipped: the server says the segment does not exist
 *   EXT-X-MAP     the plan's init segment - and there may be only one
 *
 * Why only one init: segments are concatenated byte for byte, with no remuxing.
 * An fMP4 file has one initialization segment at its start; a playlist that
 * switches init mid-stream (typically server-side ad insertion) would need a
 * muxer to produce one playable file, so it is refused with a clear message
 * rather than saved as a file that breaks at the first switch.
 */
import { ErrorCode, MediaGrabError } from '../../core/errors.ts';
import {
  assertPlanSize,
  byteRangeHeader,
  type Segment,
  type SegmentContainer,
  type SegmentPlan,
} from '../segment-plan.ts';
import { resolveUrl } from '../url.ts';
import type { HlsMediaPlaylist, HlsSegment } from './parse.ts';

export function buildHlsSegmentPlan(
  playlist: HlsMediaPlaylist,
  playlistUrl: string,
  bandwidth?: number,
): SegmentPlan {
  // Byte-range offsets run through EVERY segment, gaps included: a range with
  // no offset continues from the previous sub-range, even one that is missing.
  const nextOffset = new Map<string, number>();
  const all = playlist.segments.map((segment) => {
    const url = resolveUrl(segment.uri, playlistUrl) ?? segment.uri;
    const planned: Segment = { url, duration: segment.duration };
    if (segment.byteRange) {
      const offset = segment.byteRange.offset ?? nextOffset.get(url) ?? 0;
      nextOffset.set(url, offset + segment.byteRange.length);
      planned.range = byteRangeHeader(offset, segment.byteRange.length);
    }
    return { planned, segment };
  });

  const present = all.filter((entry) => !entry.segment.gap);
  assertPlanSize(present.length);
  const init = singleInit(
    present.map((entry) => entry.segment),
    playlistUrl,
  );
  const segments = present.map((entry) => entry.planned);

  const totalDuration = segments.reduce((sum, segment) => sum + (segment.duration ?? 0), 0);
  // BANDWIDTH is a peak rate, so this over-estimates; progress treats it as a guess.
  const estimatedBytes =
    bandwidth !== undefined && bandwidth > 0 && totalDuration > 0
      ? Math.round((bandwidth / 8) * totalDuration)
      : undefined;

  return {
    ...(init ? { init } : {}),
    segments,
    totalDuration,
    ...(estimatedBytes !== undefined ? { estimatedBytes } : {}),
    live: playlist.live,
  };
}

/**
 * What the concatenated segments are. EXT-X-MAP means fMP4 (s4.3.2.5); packed
 * audio segments (.aac or .mp3, s3.4) make a raw audio stream; anything else
 * is MPEG-TS, the HLS default (s3.2).
 */
export function hlsContainer(playlist: HlsMediaPlaylist): SegmentContainer {
  const first = playlist.segments.find((segment) => !segment.gap);
  if (first?.init) return 'mp4';
  const packedAudio = first ? /\.(aac|mp3)(?:$|[?#])/i.exec(first.uri)?.[1] : undefined;
  if (packedAudio) return packedAudio.toLowerCase() as 'aac' | 'mp3';
  return 'ts';
}

/**
 * The one initialization segment every segment uses, or none. Two different
 * inits - a new EXT-X-MAP part-way, or segments without one followed by
 * segments with one - cannot be joined into one playable file without a muxer.
 * Inits are compared by resolved URL and effective byte range, so `init.mp4`
 * written relatively and absolutely, or `600` and `600@0`, are the same init.
 */
function singleInit(segments: HlsSegment[], playlistUrl: string): Segment | undefined {
  const keys = new Set(segments.map((segment) => initKey(segment, playlistUrl)));
  if (keys.size > 1) {
    throw new MediaGrabError(
      ErrorCode.UNSUPPORTED_MANIFEST,
      'This stream changes format part-way through (often inserted adverts), which MediaGrab cannot join into one file.',
    );
  }
  const init = segments[0]?.init;
  if (!init) return undefined;
  return {
    url: resolveUrl(init.uri, playlistUrl) ?? init.uri,
    ...(init.byteRange
      ? { range: byteRangeHeader(init.byteRange.offset ?? 0, init.byteRange.length) }
      : {}),
  };
}

function initKey(segment: HlsSegment, playlistUrl: string): string {
  if (!segment.init) return 'none';
  const url = resolveUrl(segment.init.uri, playlistUrl) ?? segment.init.uri;
  const range = segment.init.byteRange;
  return range ? `${url} ${range.offset ?? 0}+${range.length}` : url;
}
