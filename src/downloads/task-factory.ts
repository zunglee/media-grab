/**
 * Turns "the user wants this candidate (in this rendition)" into the record the
 * download manager queues. Pure: no browser, no clock except the one passed in,
 * so every naming and strategy rule is unit-testable.
 */
import type {
  DownloadRequest,
  DownloadStrategy,
  DownloadTaskView,
} from '../core/download-types.ts';
import { DownloadState } from '../core/download-types.ts';
import type { MediaCandidate, MediaVariant } from '../core/types.ts';
import { fileExtensionFor } from '../media/format.ts';
import { buildFilename } from '../media/naming.ts';
import { bestVariantOf } from '../media/quality.ts';
import type { Settings } from '../storage/settings.ts';
import { ProgressTracker } from './progress.ts';

/**
 * The rendition a download will actually fetch.
 *
 *   picked by the user         -> that one
 *   manifest with a ladder     -> the recommended best (same rule as "Best download")
 *   HLS media playlist alone   -> the playlist itself: it is its own only rendition
 *   direct file                -> none
 */
export function renditionToFetch(
  candidate: MediaCandidate,
  chosen?: MediaVariant,
): MediaVariant | undefined {
  if (chosen) return chosen;
  if (candidate.protocol !== 'hls' && candidate.protocol !== 'dash') return undefined;
  return bestVariantOf(candidate) ?? playlistAsItsOwnRendition(candidate);
}

/**
 * A media playlist found without a master above it has no ladder, but it is
 * perfectly downloadable - it already lists the segments. A DASH MPD with no
 * representations, by contrast, has nothing to fetch, so it gets no stand-in.
 */
function playlistAsItsOwnRendition(candidate: MediaCandidate): MediaVariant | undefined {
  if (candidate.protocol !== 'hls') return undefined;
  return {
    id: candidate.id,
    url: candidate.url,
    kind: candidate.kind,
    protocol: 'hls',
    format: 'ts',
    tracks: candidate.tracks,
    ...(candidate.resolution ? { resolution: candidate.resolution } : {}),
  };
}

export function strategyFor(candidate: MediaCandidate, variant?: MediaVariant): DownloadStrategy {
  const protocol = variant?.protocol ?? candidate.protocol;
  if (protocol === 'hls') return 'segment-hls';
  if (protocol === 'dash') return 'segment-dash';
  return 'browser-download';
}

/**
 * The container the saved file will be. Segments are concatenated as-is (no
 * remuxing, ARCHITECTURE.md § 5), so for a segmented rendition this is a first
 * guess - MPEG-TS for HLS, fMP4 for DASH - that the engine corrects once the
 * media playlist says what the segments really are (engines.ts). A direct
 * file, a single-file DASH representation included, keeps its own container.
 */
function extensionFor(candidate: MediaCandidate, variant?: MediaVariant): string {
  if (variant?.protocol === 'hls') return 'ts';
  if (variant?.protocol === 'dash') {
    if (variant.format === 'webm') return 'webm';
    return variant.kind === 'audio' ? 'm4a' : 'mp4';
  }
  if (variant) return fileExtensionFor(variant.format, variant.kind);
  // An unrecognised container (FLV, 3GP) still gets the extension its MIME type names.
  return fileExtensionFor(candidate.format, candidate.kind, candidate.mimeType);
}

export interface NewTask {
  request: DownloadRequest;
  view: DownloadTaskView;
  tracker: ProgressTracker;
}

/**
 * The path the file is saved under, from the user's naming settings. Called
 * again by a segmented download once its playlist says what the file really
 * is, so the template's {ext}, the length cap and the name all agree.
 */
export function filenameFor(input: {
  candidate: MediaCandidate;
  variant: MediaVariant | undefined;
  settings: Settings;
  extension?: string;
}): string {
  const { candidate, variant, settings } = input;
  return buildFilename({
    candidate,
    ...(variant ? { variant } : {}),
    template: settings.downloads.namingTemplate,
    folders: {
      baseFolder: settings.downloads.baseFolder,
      siteFolders: settings.downloads.siteFolders,
      dateFolders: settings.downloads.dateFolders,
    },
    extension: input.extension ?? extensionFor(candidate, variant),
  });
}

export function createTask(input: {
  taskId: string;
  candidate: MediaCandidate;
  variant: MediaVariant | undefined;
  settings: Settings;
  now: number;
}): NewTask {
  const { taskId, candidate, variant, settings, now } = input;
  const strategy = strategyFor(candidate, variant);
  const filename = filenameFor({ candidate, variant, settings });

  const url = variant?.url ?? candidate.url;
  // A stream's separate audio track is an audio file, whatever the stream is.
  const kind = variant?.kind ?? candidate.kind;
  const request: DownloadRequest = {
    taskId,
    url,
    strategy,
    filename,
    kind,
    pageUrl: candidate.pageUrl,
  };

  // Until the browser or the assembler reports real bytes, the size the scan
  // found - which for a manifest rendition is BANDWIDTH x duration, a guess.
  const sized = variant?.sizeBytes !== undefined ? variant : candidate;
  const tracker = new ProgressTracker(sized.sizeBytes, now, sized.sizeEstimated === true);
  const view: DownloadTaskView = {
    id: taskId,
    filename,
    url,
    pageUrl: candidate.pageUrl,
    state: DownloadState.QUEUED,
    strategy,
    pausable: strategy === 'browser-download', // the manager confirms it from the engine
    kind,
    progress: tracker.snapshot(),
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };

  return { request, view, tracker };
}
