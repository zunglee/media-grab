/**
 * Fetch a segment plan and turn it into an object URL the downloads API can save.
 *
 * Where this runs matters. `URL.createObjectURL` does not exist in a Chrome MV3
 * service worker, so on Chrome this module runs inside an offscreen document
 * (src/offscreen/) and only the resulting blob: URL crosses back. On Firefox the
 * background is an event page with a DOM, so it runs in place. Either way the
 * bytes are never copied across a message boundary.
 *
 * Nor are they held twice in the page: the fetcher hands back one Blob per
 * segment, and the file is a Blob composed of those Blobs, which the browser
 * builds by reference (segment-fetcher.ts has the memory reasoning). An object
 * URL is created only for a complete file: a cancel makes `fetchSegments`
 * throw, and a failed segment throws below, both before one exists - so there
 * is nothing to revoke and nothing left holding the parts. A cancel that comes
 * after the URL exists is the engine's to handle (it releases the URL).
 *
 * REMUXING IS NOT IMPLEMENTED. Concatenated fMP4 segments (DASH, and HLS with
 * EXT-X-MAP) produce a valid, playable file. Concatenated MPEG-TS segments also
 * play in VLC/ffmpeg but are not an MP4. Separate video and audio streams are
 * NOT combined - see ARCHITECTURE.md "Muxing" for why that needs ffmpeg.wasm
 * and what the current behaviour is instead.
 */
import { ErrorCode, MediaGrabError } from '../core/errors.ts';
import { redactUrl } from '../core/redact.ts';
import type { SegmentContainer, SegmentPlan } from '../manifests/segment-plan.ts';
import { fetchSegments } from './segment-fetcher.ts';

export interface AssembleOptions {
  plan: SegmentPlan;
  mimeType: string;
  concurrency?: number;
  retries?: number;
  signal: AbortSignal;
  onProgress?: (receivedBytes: number, segmentsDone: number, segmentsTotal: number) => void;
  fetchImpl?: typeof fetch;
}

export interface AssembleResult {
  /** blob: URL owned by the caller. Revoke it after the download completes. */
  objectUrl: string;
  totalBytes: number;
}

export async function assembleToObjectUrl(options: AssembleOptions): Promise<AssembleResult> {
  if (typeof URL.createObjectURL !== 'function') {
    throw new MediaGrabError(
      ErrorCode.INTERNAL,
      'Assembly attempted in a context without createObjectURL (this is a MediaGrab bug)',
    );
  }

  const result = await fetchSegments(options);

  // A gap in the middle of a media file is not a partial success: the result
  // would be a file that stops playing halfway with no explanation.
  const [firstFailed] = result.failed;
  if (firstFailed !== undefined) {
    const total = options.plan.segments.length + (options.plan.init ? 1 : 0);
    const because = result.firstError ? `: ${result.firstError.message}` : '';
    throw new MediaGrabError(
      result.firstError?.code ?? ErrorCode.SEGMENT_FAILED,
      `Segment ${firstFailed + 1} of ${total} could not be downloaded${because}`,
      // Redacted: the detail is shown in the popup, and segment URLs carry tokens.
      // The host is not a secret, and the failed row offers access to it (D18).
      result.firstError
        ? {
            detail: `failed segment: ${redactUrl(result.firstError.url)}`,
            ...(result.firstError.host ? { host: result.firstError.host } : {}),
          }
        : undefined,
    );
  }

  // Blob parts, composed by reference: the file is not copied again here.
  const blob = new Blob(result.parts, { type: options.mimeType });
  return { objectUrl: URL.createObjectURL(blob), totalBytes: result.totalBytes };
}

/** The saved file's extension: an audio-only fMP4 is an .m4a, as players expect. */
export function assembledExtension(container: SegmentContainer, kind: string): string {
  return container === 'mp4' && kind === 'audio' ? 'm4a' : container;
}

/** MIME type of the assembled file, from what its segments are. */
export function assembledMimeType(container: SegmentContainer, kind: string): string {
  const audio = kind === 'audio';
  switch (container) {
    case 'mp4':
      return audio ? 'audio/mp4' : 'video/mp4';
    case 'webm':
      return audio ? 'audio/webm' : 'video/webm';
    case 'aac':
      return 'audio/aac';
    case 'mp3':
      return 'audio/mpeg';
    case 'ts':
      return 'video/mp2t';
  }
}
