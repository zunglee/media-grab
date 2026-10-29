/**
 * The toolbar badge and what the worker does when downloads change. The badge
 * shows how much media the tab has and nothing else (see background/badge.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDetectionBadge } from '../../src/background/badge.ts';
import { attachDownloadHooks } from '../../src/background/download-hooks.ts';
import { __setBrowserApi } from '../../src/browser/index.ts';
import { DownloadState, type DownloadTaskView } from '../../src/core/download-types.ts';
import type { CompletedListener, DownloadsListener } from '../../src/downloads/manager.ts';
import { DEFAULT_SETTINGS } from '../../src/storage/settings.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';

function install() {
  const api = createFakeBrowserApi();
  const setBadge = vi.fn(async () => undefined);
  const setTitle = vi.fn(async () => undefined);
  const sendMessage = vi.fn(async () => undefined);
  api.action.setBadge = setBadge;
  api.action.setTitle = setTitle;
  api.runtime.sendMessage = sendMessage;
  __setBrowserApi(api);
  return { setBadge, setTitle, sendMessage };
}

let browser: ReturnType<typeof install>;
beforeEach(() => {
  browser = install();
});
afterEach(() => __setBrowserApi(null));

describe('the detection badge', () => {
  it('shows the count on that tab only', async () => {
    await setDetectionBadge(4, 3);
    expect(browser.setBadge).toHaveBeenCalledWith(expect.objectContaining({ text: '3', tabId: 4 }));
    expect(browser.setTitle).toHaveBeenCalledWith('MediaGrab - 3 media resources detected', 4);
  });

  it('caps the count at 99 and clears it when nothing is found', async () => {
    await setDetectionBadge(4, 250);
    expect(browser.setBadge).toHaveBeenLastCalledWith(expect.objectContaining({ text: '99' }));
    await setDetectionBadge(4, 0);
    expect(browser.setBadge).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '', tabId: 4 }),
    );
  });
});

describe('when downloads change', () => {
  function fakeManager() {
    let changed: DownloadsListener = () => undefined;
    let completed: CompletedListener = () => undefined;
    const manager = {
      onChange: (listener: DownloadsListener) => {
        changed = listener;
        return () => undefined;
      },
      onTaskCompleted: (listener: CompletedListener) => {
        completed = listener;
        return () => undefined;
      },
    };
    attachDownloadHooks(manager, async () => DEFAULT_SETTINGS);
    return {
      change: (tasks: DownloadTaskView[]) => changed(tasks),
      complete: (task: DownloadTaskView) => completed(task),
    };
  }

  const task: DownloadTaskView = {
    id: 't1',
    filename: 'MediaGrab/film.mp4',
    url: 'https://cdn.example/film.mp4',
    pageUrl: 'https://video.example/watch',
    state: DownloadState.DOWNLOADING,
    strategy: 'browser-download',
    pausable: true,
    kind: 'video',
    progress: { receivedBytes: 5, totalBytes: 10, speedBps: 1 },
    createdAt: 1,
    updatedAt: 1,
    attempts: 1,
  };

  it('regression C5/C24: tells open popups and leaves the badge alone', () => {
    const { change } = fakeManager();
    change([task]);
    change([{ ...task, state: DownloadState.COMPLETED, completedAt: Date.now() }]);

    expect(browser.sendMessage).toHaveBeenCalledWith({ type: 'DOWNLOADS_STATE', tasks: [task] });
    expect(browser.setBadge).not.toHaveBeenCalled();
    expect(browser.setTitle).not.toHaveBeenCalled();
  });
});
