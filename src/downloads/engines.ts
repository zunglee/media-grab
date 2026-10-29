/**
 * How a task's bytes are fetched. The manager decides WHEN a task runs and
 * what state it is in; an engine decides HOW the bytes arrive. Another way to
 * download that ends, like these two, by handing the browser a file - a muxer,
 * say - is a new engine, not an edit to the manager.
 *
 *   browserEngine    hand the URL to the browser. It streams to disk, keeps a
 *                    partial file (so it can pause and resume), and shows the
 *                    download shelf. Used for every direct file.
 *   segmentedEngine  rebuild the segment plan from the manifest, fetch and
 *                    assemble the segments in memory, then hand the finished
 *                    blob to the browser. Used for HLS and DASH renditions.
 *                    Only the media playlist says whether its segments are
 *                    MPEG-TS or fMP4, so this engine settles the file's
 *                    extension, through `run.rename`, before any segment.
 *                    The playlist fetch is retried like a segment is.
 *
 * Either way `start` resolves once the browser has been handed the file; the
 * browser reports completion later through `downloads.onChanged`.
 */
import { browserApi } from '../browser/index.ts';
import type { DownloadRequest, DownloadStrategy } from '../core/download-types.ts';
import { ErrorCode, MediaGrabError } from '../core/errors.ts';
import type { MediaCandidate, MediaVariant } from '../core/types.ts';
import type { Settings } from '../storage/settings.ts';
import { assembledExtension, assembledMimeType } from './assembler.ts';
import { assemble, releaseObjectUrl } from './assembly-host.ts';
import { buildPlanForVariant } from './plan-builder.ts';
import { retrying } from './retry.ts';

export interface ProgressUpdate {
  receivedBytes: number;
  totalBytes?: number;
  /** `totalBytes` is a guess from the manifest, not a reported size. */
  totalEstimated?: boolean;
  segmentsDone?: number;
  segmentsTotal?: number;
}

/** Everything an engine needs for one attempt at one task. */
export interface EngineRun {
  request: DownloadRequest;
  candidate: MediaCandidate;
  variant: MediaVariant | undefined;
  settings: Settings;
  /** Aborted when the user pauses or cancels. */
  signal: AbortSignal;
  onProgress(update: ProgressUpdate): void;
  /** Every byte is in hand; the browser is about to write the file. */
  onVerifying(): void;
  /**
   * The file turned out to be a different container than first guessed (an
   * HLS rendition that is fMP4, not MPEG-TS). Returns the path to save under,
   * rebuilt from the naming settings with that extension.
   */
  rename(extension: string): string;
  /**
   * About to fetch from these URLs' hosts: name the page as Referer to them
   * for the rest of the task (referer-rules.ts, ARCHITECTURE.md D18).
   */
  willFetch(urls: string[]): Promise<void>;
}

export interface Handoff {
  /** The browser's id for the file it is now writing. */
  browserDownloadId: number;
  /**
   * Free whatever the engine is holding for this file (the segmented engine's
   * assembled blob). Called once the browser has finished with it, or the task
   * was stopped.
   */
  release?: () => void;
}

export interface DownloadEngine {
  /**
   * True when the browser itself fetches the bytes. The browser then holds the
   * partial file, so pause and resume are delegated to it, and its download
   * record is the only source of progress.
   */
  readonly browserFetches: boolean;
  /**
   * True when the engine already retries each piece that can fail on its own.
   * The manager then does not rerun the whole attempt on top: for a segmented
   * download that would refetch every good segment, (retries + 1)^2 times over.
   */
  readonly retriesItself: boolean;
  start(run: EngineRun): Promise<Handoff>;
}

function saveToDisk(url: string, filename: string, run: EngineRun): Promise<number> {
  return browserApi().downloads.download({
    url,
    filename,
    saveAs: run.settings.downloads.askWhereToSave,
    conflictAction: 'uniquify',
  });
}

/**
 * Setting a Referer rule is a round trip to the browser; the user may pause or
 * cancel meanwhile. Stop there, before a Save dialog opens or the offscreen
 * document is asked to fetch a stream nobody wants.
 */
function stopIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new MediaGrabError(ErrorCode.CANCELLED, 'Cancelled');
}

export const browserEngine: DownloadEngine = {
  browserFetches: true,
  retriesItself: false,
  async start(run) {
    await run.willFetch([run.request.url]);
    stopIfAborted(run.signal);
    return { browserDownloadId: await saveToDisk(run.request.url, run.request.filename, run) };
  },
};

export const segmentedEngine: DownloadEngine = {
  browserFetches: false,
  retriesItself: true,
  async start(run) {
    if (!run.variant) {
      throw new MediaGrabError(
        ErrorCode.UNSUPPORTED_MANIFEST,
        'This manifest lists no rendition MediaGrab can download.',
      );
    }

    // Rebuilt now rather than cached from the scan (ARCHITECTURE.md D9).
    const variant = run.variant;
    await run.willFetch([variant.url, run.candidate.url]);
    stopIfAborted(run.signal);
    const { plan, container } = await retrying(
      () => buildPlanForVariant(run.candidate, variant, { signal: run.signal }),
      { retries: run.settings.downloads.retryCount, signal: run.signal },
    );
    const filename = run.rename(assembledExtension(container, run.request.kind));
    // Segments are often on another host than the playlist (a CDN).
    await run.willFetch([
      ...(plan.init ? [plan.init.url] : []),
      ...plan.segments.map((segment) => segment.url),
    ]);
    stopIfAborted(run.signal);
    if (plan.estimatedBytes !== undefined) {
      run.onProgress({ receivedBytes: 0, totalBytes: plan.estimatedBytes, totalEstimated: true });
    }

    const assembled = await assemble({
      taskId: run.request.taskId,
      plan,
      mimeType: assembledMimeType(container, run.request.kind),
      concurrency: run.settings.downloads.segmentConcurrency,
      retries: run.settings.downloads.retryCount,
      signal: run.signal,
      onProgress: (receivedBytes, segmentsDone, segmentsTotal) =>
        run.onProgress({ receivedBytes, segmentsDone, segmentsTotal }),
    });

    // The blob is the entire file in memory; it must be freed exactly once.
    const release = () => void releaseObjectUrl(assembled.objectUrl).catch(() => undefined);

    // Stopped after the last segment arrived but before the browser was asked
    // to save: do not open a Save dialog for a download the user cancelled.
    try {
      stopIfAborted(run.signal);
    } catch (err) {
      release();
      throw err;
    }

    run.onVerifying();
    run.onProgress({ receivedBytes: assembled.totalBytes, totalBytes: assembled.totalBytes });
    try {
      const browserDownloadId = await saveToDisk(assembled.objectUrl, filename, run);
      return { browserDownloadId, release };
    } catch (err) {
      release();
      throw err;
    }
  },
};

export const DEFAULT_ENGINES: Record<DownloadStrategy, DownloadEngine> = {
  'browser-download': browserEngine,
  'segment-hls': segmentedEngine,
  'segment-dash': segmentedEngine,
};
