/**
 * Progress, speed and ETA.
 *
 * Instantaneous speed is useless in a UI: segment downloads arrive in bursts,
 * so a raw bytes/second reading swings between 0 and 80 MB/s several times a
 * second. This uses an exponentially weighted moving average, which is stable
 * enough to read and still reacts within a couple of seconds to a real change.
 */
import type { DownloadProgress } from '../core/download-types.ts';

/** Weight of the newest sample. 0.25 settles in ~4 samples. */
const SMOOTHING = 0.25;
/** Ignore samples shorter than this; the clock noise dominates below it. */
const MIN_SAMPLE_MS = 200;

export class ProgressTracker {
  private received = 0;
  private total: number | undefined;
  private totalEstimated = false;
  private speedBps = 0;
  private lastBytes = 0;
  private lastAt: number;
  private segmentsDone = 0;
  private segmentsTotal: number | undefined;

  constructor(totalBytes?: number, now: number = Date.now(), estimated = false) {
    this.total = totalBytes;
    this.totalEstimated = totalBytes !== undefined && estimated;
    this.lastAt = now;
  }

  setTotal(totalBytes: number | undefined, estimated = false): void {
    this.total = totalBytes;
    this.totalEstimated = totalBytes !== undefined && estimated;
  }

  setSegments(done: number, total: number): void {
    this.segmentsDone = done;
    this.segmentsTotal = total;
  }

  /** Absolute byte count, not a delta: resumed downloads jump forward. */
  update(receivedBytes: number, now: number = Date.now()): void {
    this.received = receivedBytes;
    const elapsed = now - this.lastAt;
    if (elapsed < MIN_SAMPLE_MS) return;

    const delta = receivedBytes - this.lastBytes;
    if (delta >= 0) {
      const instant = (delta / elapsed) * 1000;
      this.speedBps =
        this.speedBps === 0 ? instant : this.speedBps * (1 - SMOOTHING) + instant * SMOOTHING;
    }
    this.lastBytes = receivedBytes;
    this.lastAt = now;
  }

  /** Speed stays where it was, so a resumed download does not read 0 B/s. */
  pause(): void {
    this.lastAt = Date.now();
    this.lastBytes = this.received;
  }

  snapshot(): DownloadProgress {
    const eta = this.etaSeconds();
    return {
      receivedBytes: this.received,
      ...(this.total !== undefined ? { totalBytes: this.total } : {}),
      ...(this.totalEstimated ? { totalEstimated: true } : {}),
      speedBps: Math.max(0, Math.round(this.speedBps)),
      ...(eta !== undefined ? { etaSeconds: eta } : {}),
      ...(this.segmentsTotal !== undefined
        ? { segmentsDone: this.segmentsDone, segmentsTotal: this.segmentsTotal }
        : {}),
    };
  }

  private etaSeconds(): number | undefined {
    if (this.speedBps <= 0) return undefined;
    const total = this.expectedTotal();
    if (total === undefined) return undefined;
    return Math.round(Math.max(0, total - this.received) / this.speedBps);
  }

  /**
   * The best available guess at the final size. A segment count is exact while
   * a manifest's BANDWIDTH is a peak rate, so once some segments are in, their
   * average size predicts the total better than the estimate does.
   */
  private expectedTotal(): number | undefined {
    if (this.segmentsTotal !== undefined && this.segmentsDone > 0) {
      return (this.received / this.segmentsDone) * this.segmentsTotal;
    }
    return this.total !== undefined && this.total > 0 ? this.total : undefined;
  }
}

/**
 * 0-1. Segment counts first: they are exact, while a segmented download's byte
 * total is only an estimate until the last segment arrives. Byte totals next
 * (a direct file's Content-Length). Never above 1, even when the estimate was low.
 */
export function fractionComplete(progress: DownloadProgress): number {
  if (progress.segmentsTotal !== undefined && progress.segmentsTotal > 0) {
    return Math.min(1, (progress.segmentsDone ?? 0) / progress.segmentsTotal);
  }
  if (progress.totalBytes !== undefined && progress.totalBytes > 0) {
    return Math.min(1, progress.receivedBytes / progress.totalBytes);
  }
  return 0;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '--';
  const mb = bytesPerSecond / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  const kb = bytesPerSecond / 1024;
  return `${Math.round(kb)} KB/s`;
}

export function formatEta(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.round(seconds % 60)} sec`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
