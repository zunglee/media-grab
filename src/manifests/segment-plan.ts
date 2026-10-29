/**
 * The one shape the download engine understands, whatever the manifest format.
 * HLS and DASH both compile down to this before a byte is fetched.
 */
import { ErrorCode, MediaGrabError } from '../core/errors.ts';

export interface Segment {
  url: string;
  /** HTTP Range header value, e.g. "bytes=0-1023". Undefined = whole resource. */
  range?: string;
  /** Seconds, when the manifest says. Used for progress when sizes are unknown. */
  duration?: number;
}

export interface SegmentPlan {
  /** Initialization segment (fMP4 `init.mp4` / HLS EXT-X-MAP). Written first. */
  init?: Segment;
  segments: Segment[];
  /** Sum of segment durations, seconds. */
  totalDuration: number;
  /** Estimated total bytes, when bandwidth is known. */
  estimatedBytes?: number;
  /** True when the source playlist had no end marker. */
  live: boolean;
}

/**
 * What concatenating the segments produces, which decides the saved file's
 * extension and MIME type. Only the media playlist knows it (an EXT-X-MAP means
 * fMP4), so it is settled when the plan is built, not when the task is queued.
 */
export type SegmentContainer = 'ts' | 'mp4' | 'aac' | 'mp3' | 'webm';

/**
 * The most segments one download may have. The plan is held in memory and
 * sent to the assembler in one message, and every byte is assembled in memory
 * too (core/limits.ts MAX_ASSEMBLY_BYTES, enforced in segment-fetcher.ts). 20,000 segments is 11 hours of
 * typical 2-second segments. A longer stream is refused, never cut short: a
 * file that silently stops early is worse than a clear "too long".
 */
export const MAX_PLAN_SEGMENTS = 20_000;

export function assertPlanSize(segmentCount: number): void {
  if (segmentCount > MAX_PLAN_SEGMENTS) {
    throw new MediaGrabError(
      ErrorCode.UNSUPPORTED_MANIFEST,
      `This stream has ${segmentCount.toLocaleString('en')} segments; MediaGrab can assemble at most ${MAX_PLAN_SEGMENTS.toLocaleString('en')} in the browser.`,
    );
  }
}

export function byteRangeHeader(offset: number, length: number): string {
  return `bytes=${offset}-${offset + length - 1}`;
}
