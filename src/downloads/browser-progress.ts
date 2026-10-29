/**
 * Byte progress for downloads the browser is fetching itself.
 *
 * `downloads.onChanged` reports state transitions, not bytes, so a direct file
 * would otherwise sit at 0% until it finished. This polls the browser's record
 * while the download is in flight, and stops by itself as soon as the browser
 * says it has left `in_progress` (completion and failure are still handled by
 * `onChanged`; this only keeps the last reading from being stale).
 */
import type { DownloadItemInfo } from '../browser/api.ts';
import { browserApi } from '../browser/index.ts';

/** Fast enough to look live, slow enough not to keep the worker awake. */
const POLL_MS = 500;

export class BrowserProgressPoller {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  watch(taskId: string, downloadId: number, onReading: (item: DownloadItemInfo) => void): void {
    if (this.timers.has(taskId)) return;

    const tick = async (): Promise<void> => {
      const item = await browserApi()
        .downloads.search(downloadId)
        .catch(() => undefined);
      if (!this.timers.has(taskId)) return; // stopped while the search was in flight
      if (!item) {
        this.stop(taskId);
        return;
      }
      if (item.state !== 'in_progress') this.stop(taskId);
      onReading(item);
    };

    this.timers.set(
      taskId,
      setInterval(() => void tick(), POLL_MS),
    );
    void tick();
  }

  stop(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer === undefined) return;
    clearInterval(timer);
    this.timers.delete(taskId);
  }
}
