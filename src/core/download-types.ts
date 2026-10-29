import type { ErrorCode } from './errors.ts';
import type { MediaKind } from './types.ts';

/**
 * Download state machine (PRD s39).
 *
 *   QUEUED -> DOWNLOADING -> VERIFYING -> COMPLETED
 *                 |    ^
 *                 v    |
 *              PAUSED -> RESUMING
 *
 *   any live state -> FAILED -> (retry) QUEUED
 *   any live state -> CANCELLED
 *
 * DOWNLOADING -> COMPLETED skips VERIFYING for direct files, which the browser
 * fetches and writes itself. PAUSED -> COMPLETED exists because a direct file
 * can finish in the instant between our pause request and the browser's reply;
 * the file on disk is complete, so that is what the task must say.
 */
export const DownloadState = {
  QUEUED: 'QUEUED',
  DOWNLOADING: 'DOWNLOADING',
  PAUSED: 'PAUSED',
  RESUMING: 'RESUMING',
  VERIFYING: 'VERIFYING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type DownloadState = (typeof DownloadState)[keyof typeof DownloadState];

/** Legal transitions. Enforced in downloads/state-machine.ts; anything else is a bug. */
export const ALLOWED_TRANSITIONS: Record<DownloadState, readonly DownloadState[]> = {
  QUEUED: ['DOWNLOADING', 'PAUSED', 'CANCELLED', 'FAILED'],
  DOWNLOADING: ['PAUSED', 'VERIFYING', 'FAILED', 'CANCELLED', 'COMPLETED'],
  PAUSED: ['RESUMING', 'CANCELLED', 'FAILED', 'COMPLETED'],
  RESUMING: ['DOWNLOADING', 'FAILED', 'CANCELLED', 'PAUSED'],
  VERIFYING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['QUEUED', 'CANCELLED'],
  CANCELLED: [],
};

export const TERMINAL_STATES: readonly DownloadState[] = ['COMPLETED', 'CANCELLED'];

/** How the bytes are actually fetched. Decides which engine runs the task. */
export type DownloadStrategy =
  | 'browser-download' // hand the URL to chrome.downloads, best for plain files
  | 'segment-hls' // fetch + concatenate HLS media segments
  | 'segment-dash'; // fetch + concatenate DASH segments

/** What one task fetches and where it saves it. Built once, by task-factory.ts. */
export interface DownloadRequest {
  taskId: string;
  /** The rendition's URL for a manifest, the file's URL otherwise. */
  url: string;
  strategy: DownloadStrategy;
  filename: string;
  kind: MediaKind;
  pageUrl: string;
}

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes?: number;
  /**
   * True while `totalBytes` is a guess (a manifest's BANDWIDTH x duration)
   * rather than a size the server or the assembler reported. Show it as "~".
   */
  totalEstimated?: boolean;
  /** bytes/second, exponentially smoothed. */
  speedBps: number;
  /** seconds; undefined when the total size is unknown. */
  etaSeconds?: number;
  segmentsDone?: number;
  segmentsTotal?: number;
}

/** Serializable view of a task, the shape the UI receives. */
export interface DownloadTaskView {
  id: string;
  filename: string;
  url: string;
  pageUrl: string;
  state: DownloadState;
  strategy: DownloadStrategy;
  /**
   * Pause keeps the work done: the browser holds the partial file. False for a
   * segmented download, whose bytes are in memory until assembly - pausing it
   * would throw them away, so the popup offers only Cancel. Set by the manager
   * from the engine (`browserFetches`).
   */
  pausable: boolean;
  kind: MediaKind;
  progress: DownloadProgress;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  attempts: number;
  /**
   * False when the task can no longer be retried: it was recovered after an
   * extension update or browser restart from a URL-free trace, so there is no
   * address left to fetch (ARCHITECTURE.md D16). Absent means true.
   */
  canRetry?: boolean;
  error?: {
    code: ErrorCode;
    message: string;
    /**
     * A host that refused (403) and that MediaGrab has no access to, so could
     * not name the page to as Referer. The row offers "Allow <host> and retry"
     * (ARCHITECTURE.md D18). Absent when a grant would not help.
     */
    accessHost?: string;
  };
  /** Set once the browser has been handed the file (it may still be writing it). */
  browserDownloadId?: number;
}
