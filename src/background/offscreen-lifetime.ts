/**
 * Closes the offscreen document when no segmented download needs it
 * (ARCHITECTURE.md D4, D16).
 *
 * The document holds each assembled file in memory until the browser has
 * written it. It used to stay open for the life of the extension, and a worker
 * killed mid-assembly left whatever the document held behind. Closing it
 * whenever nothing is fetching, assembling or being written frees both - and
 * the first check runs as soon as the download manager starts, which is
 * exactly when a previous worker's leftovers would still be there.
 *
 * Closing and creating are serialised in `browser/webext.ts`, so a download
 * that starts while the document is closing gets a fresh one.
 */
import { browserApi } from '../browser/index.ts';
import { DownloadState, type DownloadTaskView } from '../core/download-types.ts';
import type { DownloadManager, RecoveredTask } from '../downloads/manager.ts';

/** A segmented download that is fetching, assembling, or being written from a blob. */
function needsTheDocument(task: DownloadTaskView): boolean {
  return (
    task.strategy !== 'browser-download' &&
    (task.state === DownloadState.DOWNLOADING || task.state === DownloadState.VERIFYING)
  );
}

/**
 * Before a new worker restores the queue: a document a killed worker left open
 * may still be fetching a download that is about to be marked interrupted, and
 * holds whatever it assembled. Close it - unless the browser may still be
 * writing a file from one of its blobs.
 */
export async function closeLeftoverDocument(recovered: RecoveredTask[]): Promise<void> {
  const offscreen = browserApi().offscreen;
  if (!offscreen.isSupported()) return;
  const writing = recovered.some((task) => {
    const strategy = 'record' in task ? task.record.view.strategy : task.trace.strategy;
    return strategy !== 'browser-download' && task.browser?.state === 'in_progress';
  });
  if (!writing) await offscreen.close().catch(() => undefined);
}

export function closeOffscreenWhenIdle(manager: Pick<DownloadManager, 'list' | 'onChange'>): void {
  const offscreen = browserApi().offscreen;
  if (!offscreen.isSupported()) return;
  // Unknown at start: a previous worker may have left the document open.
  let inUse = true;
  const check = (tasks: DownloadTaskView[]): void => {
    const now = tasks.some(needsTheDocument);
    if (inUse && !now) void offscreen.close().catch(() => undefined);
    inUse = now;
  };
  check(manager.list());
  manager.onChange(check);
}
