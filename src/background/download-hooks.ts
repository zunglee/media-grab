/**
 * What the worker does when downloads change, kept out of the download
 * manager so the manager stays about the queue:
 *
 *   any change      -> DOWNLOADS_STATE broadcast to open popups
 *   a completion    -> history entry + "Download complete" notification,
 *                      each only if the user's settings allow it
 *
 * Download progress is deliberately not put on the toolbar badge; badge.ts
 * says why.
 */
import { browserApi } from '../browser/index.ts';
import type { DownloadTaskView } from '../core/download-types.ts';
import { toMediaGrabError } from '../core/errors.ts';
import { createLogger } from '../core/log.ts';
import type { DownloadManager } from '../downloads/manager.ts';
import { addHistoryEntry } from '../storage/history.ts';
import type { Settings } from '../storage/settings.ts';

const log = createLogger('download-hooks');

export function attachDownloadHooks(
  manager: Pick<DownloadManager, 'onChange' | 'onTaskCompleted'>,
  currentSettings: () => Promise<Settings>,
): void {
  manager.onChange((tasks) => {
    void browserApi().runtime.sendMessage({ type: 'DOWNLOADS_STATE', tasks });
  });

  manager.onTaskCompleted((task) => {
    void recordCompletion(task, currentSettings).catch((err) =>
      log.warn('could not record a finished download', toMediaGrabError(err).message),
    );
  });
}

async function recordCompletion(
  task: DownloadTaskView,
  currentSettings: () => Promise<Settings>,
): Promise<void> {
  const settings = await currentSettings();
  if (settings.privacy.keepHistory) {
    await addHistoryEntry(task, settings.privacy.historyLimit);
  }
  if (settings.general.notifications) {
    await browserApi()
      .notifications.create(`mediagrab-${task.id}`, {
        title: 'Download complete',
        message: task.filename,
      })
      .catch(() => undefined);
  }
}
