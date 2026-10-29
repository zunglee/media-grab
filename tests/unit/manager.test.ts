/**
 * The download manager's queue rules, driven through fake engines and a fake
 * browser. Each test names the flow it pins; the ones marked "regression" were
 * real bugs in 0.1.3 (../../reports/2026-09-25-solid-audit.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { carryDownloads } from '../../src/background/queue-store.ts';
import type { BrowserApi, DownloadItemInfo } from '../../src/browser/api.ts';
import { __setBrowserApi } from '../../src/browser/index.ts';
import { DownloadState, type DownloadStrategy } from '../../src/core/download-types.ts';
import { ErrorCode, MediaGrabError } from '../../src/core/errors.ts';
import type { MediaCandidate, MediaVariant } from '../../src/core/types.ts';
import {
  browserEngine,
  type DownloadEngine,
  type EngineRun,
  type Handoff,
} from '../../src/downloads/engines.ts';
import { DownloadManager } from '../../src/downloads/manager.ts';
import { renditionToFetch } from '../../src/downloads/task-factory.ts';
import { pickBestDownload } from '../../src/media/quality.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../src/storage/settings.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';

function settings(patch: Partial<Settings['downloads']> = {}): Settings {
  return { ...DEFAULT_SETTINGS, downloads: { ...DEFAULT_SETTINGS.downloads, ...patch } };
}

function candidate(overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return {
    id: overrides.id ?? `c-${Math.random().toString(36).slice(2)}`,
    url: 'https://cdn.example/feature.mp4',
    pageUrl: 'https://site.example/watch',
    pageTitle: 'Feature',
    kind: 'video',
    protocol: 'progressive',
    format: 'mp4',
    source: 'dom-element',
    seenAt: 1,
    tracks: { video: true, audio: true },
    ...overrides,
  };
}

function rung(height: number, bandwidth: number): MediaVariant {
  return {
    id: `v${height}`,
    url: `https://cdn.example/${height}/index.m3u8`,
    kind: 'video',
    protocol: 'hls',
    format: 'ts',
    bandwidth,
    resolution: { width: Math.round((height * 16) / 9), height },
    tracks: { video: true, audio: true },
  };
}

/** A browser whose download records we control. */
function fakeBrowser() {
  const api = createFakeBrowserApi();
  let nextId = 100;
  const downloads = {
    download: vi.fn(async () => nextId++),
    cancel: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    search: vi.fn(async (_id: number): Promise<DownloadItemInfo | undefined> => undefined),
  };
  Object.assign(api.downloads, downloads);
  __setBrowserApi(api as BrowserApi);
  return downloads;
}

/** An engine whose attempts the test finishes by hand. */
function manualEngine(browserFetches = false) {
  const runs: Array<{ run: EngineRun; finish: (h: Handoff) => void; fail: (e: unknown) => void }> =
    [];
  const engine: DownloadEngine = {
    browserFetches,
    retriesItself: false,
    start: (run) =>
      new Promise<Handoff>((resolve, reject) => {
        runs.push({ run, finish: resolve, fail: reject });
      }),
  };
  return { engine, runs };
}

function engines(engine: DownloadEngine): Record<DownloadStrategy, DownloadEngine> {
  return { 'browser-download': engine, 'segment-hls': engine, 'segment-dash': engine };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  __setBrowserApi(null);
});

describe('"Best download" picks the best rendition, not the first one listed', () => {
  it('regression: an ascending ladder still yields 1080p', () => {
    const ladder = [rung(240, 400_000), rung(480, 1_400_000), rung(1080, 5_000_000)];
    const best = pickBestDownload([
      candidate({ protocol: 'hls', format: 'unknown', variants: ladder }),
    ]);
    expect(best?.variant?.resolution?.height).toBe(1080);
  });

  it('skips DRM-protected candidates', () => {
    const best = pickBestDownload([
      candidate({ id: 'drm', drm: true }),
      candidate({ id: 'plain' }),
    ]);
    expect(best?.candidate.id).toBe('plain');
    expect(best?.variant).toBeUndefined();
  });
});

describe('which rendition a download fetches', () => {
  it('regression: a lone HLS media playlist is its own rendition', () => {
    const lone = candidate({
      url: 'https://cdn.example/stream/index.m3u8',
      protocol: 'hls',
      variants: [],
    });
    const variant = renditionToFetch(lone);
    expect(variant?.url).toBe(lone.url);
    expect(variant?.protocol).toBe('hls');
  });

  it('a DASH manifest with no representations gets no stand-in', () => {
    expect(renditionToFetch(candidate({ protocol: 'dash', variants: [] }))).toBeUndefined();
  });

  it('a direct file has no rendition', () => {
    expect(renditionToFetch(candidate())).toBeUndefined();
  });
});

describe('download manager', () => {
  it('fills every free slot and no more', async () => {
    fakeBrowser();
    const { engine, runs } = manualEngine();
    const manager = new DownloadManager(settings({ concurrentDownloads: 2 }), engines(engine));

    for (let i = 0; i < 3; i += 1) {
      manager.enqueue(candidate({ url: `https://cdn.example/${i}.mp4` }));
    }
    expect(runs).toHaveLength(2);

    runs[0]?.finish({ browserDownloadId: 1 });
    await flush();
    // Handed to the browser is still "downloading": the slot stays taken.
    expect(runs).toHaveLength(2);

    await manager.handleBrowserDownloadChanged({ id: 1, state: 'complete' });
    expect(runs).toHaveLength(3);
  });

  it('regression: pausing a direct file pauses the browser download and resume continues it', async () => {
    const browser = fakeBrowser();
    const manager = new DownloadManager(settings(), engines(browserEngine));

    const taskId = manager.enqueue(candidate());
    await flush();
    expect(browser.download).toHaveBeenCalledTimes(1);

    expect(manager.command(taskId, 'pause')).toBe(true);
    expect(browser.pause).toHaveBeenCalledWith(100);
    expect(manager.list()[0]?.state).toBe(DownloadState.PAUSED);

    expect(manager.command(taskId, 'resume')).toBe(true);
    await flush();
    expect(browser.resume).toHaveBeenCalledWith(100);
    expect(browser.download, 'resume must not start a second copy').toHaveBeenCalledTimes(1);
    expect(manager.list()[0]?.state).toBe(DownloadState.DOWNLOADING);
  });

  it('records a direct file that finished in the instant it was being paused', async () => {
    fakeBrowser();
    const manager = new DownloadManager(settings(), engines(browserEngine));
    const completed = vi.fn();
    manager.onTaskCompleted(completed);

    const taskId = manager.enqueue(candidate());
    await flush();
    manager.command(taskId, 'pause');
    await manager.handleBrowserDownloadChanged({ id: 100, state: 'complete' });

    expect(manager.list()[0]?.state).toBe(DownloadState.COMPLETED);
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('regression: pausing while the manifest is loading does not restart the download', async () => {
    fakeBrowser();
    const { engine, runs } = manualEngine();
    const manager = new DownloadManager(settings(), engines(engine));

    const taskId = manager.enqueue(
      candidate({ protocol: 'hls', url: 'https://cdn.example/index.m3u8', variants: [] }),
    );
    expect(runs).toHaveLength(1);

    manager.command(taskId, 'pause');
    expect(runs[0]?.run.signal.aborted).toBe(true);
    // The abort surfaces as whatever error the fetch happened to throw -
    // retryable, in 0.1.3, which re-queued the task behind the user's back.
    runs[0]?.fail(new MediaGrabError(ErrorCode.NETWORK_ERROR, 'Could not load the manifest'));
    await flush();

    expect(manager.list()[0]?.state).toBe(DownloadState.PAUSED);
    expect(runs).toHaveLength(1);
  });

  it('retries a retryable failure, then gives up with the classified error', async () => {
    fakeBrowser();
    const { engine, runs } = manualEngine();
    const manager = new DownloadManager(settings({ retryCount: 1 }), engines(engine));

    manager.enqueue(candidate());
    runs[0]?.fail(new MediaGrabError(ErrorCode.NETWORK_ERROR, 'reset'));
    await flush();
    expect(runs).toHaveLength(2);

    runs[1]?.fail(new MediaGrabError(ErrorCode.NETWORK_ERROR, 'reset again'));
    await flush();
    const [task] = manager.list();
    expect(task?.state).toBe(DownloadState.FAILED);
    expect(task?.error?.code).toBe(ErrorCode.NETWORK_ERROR);
  });

  it('does not retry an error that retrying cannot fix', async () => {
    fakeBrowser();
    const { engine, runs } = manualEngine();
    const manager = new DownloadManager(settings({ retryCount: 5 }), engines(engine));

    manager.enqueue(candidate());
    runs[0]?.fail(new MediaGrabError(ErrorCode.AUTH_REQUIRED, 'sign in'));
    await flush();
    expect(runs).toHaveLength(1);
    expect(manager.list()[0]?.state).toBe(DownloadState.FAILED);
  });

  it('a cancelled task stays cancelled when the browser then reports it interrupted', async () => {
    const browser = fakeBrowser();
    const manager = new DownloadManager(settings(), engines(browserEngine));

    const taskId = manager.enqueue(candidate());
    await flush();
    manager.command(taskId, 'cancel');
    expect(browser.cancel).toHaveBeenCalledWith(100);

    await manager.handleBrowserDownloadChanged({
      id: 100,
      state: 'interrupted',
      error: 'USER_CANCELED',
    });
    const [task] = manager.list();
    expect(task?.state).toBe(DownloadState.CANCELLED);
    expect(task?.error).toBeUndefined();
  });

  it('takes back a file handed to the browser after the user already cancelled', async () => {
    const browser = fakeBrowser();
    const { engine, runs } = manualEngine(true);
    const manager = new DownloadManager(settings(), engines(engine));

    const taskId = manager.enqueue(candidate());
    manager.command(taskId, 'cancel');
    runs[0]?.finish({ browserDownloadId: 7 });
    await flush();

    expect(browser.cancel).toHaveBeenCalledWith(7);
    expect(manager.list()[0]?.browserDownloadId).toBeUndefined();
  });

  it('reports a completion exactly once', async () => {
    fakeBrowser();
    const manager = new DownloadManager(settings(), engines(browserEngine));
    const completed = vi.fn();
    manager.onTaskCompleted(completed);

    manager.enqueue(candidate());
    await flush();
    await manager.handleBrowserDownloadChanged({ id: 100, state: 'complete' });
    await manager.handleBrowserDownloadChanged({ id: 100, state: 'complete' });
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('joins a download of the same media that is already running', () => {
    fakeBrowser();
    const { engine } = manualEngine();
    const manager = new DownloadManager(settings(), engines(engine));

    const first = manager.enqueue(candidate({ id: 'a' }));
    const second = manager.enqueue(candidate({ id: 'a' }));
    expect(second).toBe(first);
    expect(manager.list()).toHaveLength(1);
  });

  it('refuses DRM before anything is fetched', () => {
    fakeBrowser();
    const { engine, runs } = manualEngine();
    const manager = new DownloadManager(settings(), engines(engine));
    expect(() => manager.enqueue(candidate({ drm: true }))).toThrow(
      expect.objectContaining({ code: ErrorCode.DRM_PROTECTED }),
    );
    expect(runs).toHaveLength(0);
  });
});

describe('a download paused in the browser outlives the worker that paused it', () => {
  it('re-review: a new manager adopts it, and Resume continues the same browser download', async () => {
    const browser = fakeBrowser();
    const before = new DownloadManager(settings(), engines(browserEngine));
    const taskId = before.enqueue(candidate());
    await flush();
    before.command(taskId, 'pause');
    const records = before.records();
    expect(records).toHaveLength(1);

    // The worker is stopped; a new one starts with an empty queue.
    const after = new DownloadManager(settings(), engines(browserEngine));
    after.restore(
      (JSON.parse(JSON.stringify(records)) as typeof records).map((record) => ({
        record,
        browser: { id: 100, state: 'in_progress', bytesReceived: 5, totalBytes: 10, paused: true },
      })),
    );
    expect(after.list()[0]?.state).toBe(DownloadState.PAUSED);

    expect(after.command(taskId, 'resume')).toBe(true);
    await flush();
    expect(browser.resume).toHaveBeenCalledWith(100);
    expect(browser.download).toHaveBeenCalledTimes(1);
  });

  it('saves paused tasks and, after a restart, adopts only those the browser still holds', async () => {
    const browser = fakeBrowser();
    const api = createFakeBrowserApi();
    const storage = { session: api.storage.session, local: api.storage.local };

    const first = new DownloadManager(settings(), engines(browserEngine));
    await carryDownloads(first, storage);
    const kept = first.enqueue(candidate({ url: 'https://cdn.example/kept.mp4' }));
    const gone = first.enqueue(candidate({ url: 'https://cdn.example/gone.mp4' }));
    await flush();
    first.command(kept, 'pause');
    first.command(gone, 'pause');
    await flush();

    // Meanwhile the user cleared the second one from the browser's download list.
    browser.search.mockImplementation(async (id: number) =>
      id === 100
        ? { id, state: 'in_progress' as const, bytesReceived: 10, totalBytes: 100, paused: true }
        : undefined,
    );
    const second = new DownloadManager(settings(), engines(browserEngine));
    await carryDownloads(second, storage);
    const states = Object.fromEntries(second.list().map((task) => [task.id, task.state]));
    expect(states[kept]).toBe(DownloadState.PAUSED);
    // D16: the one the browser no longer lists is shown as interrupted, not dropped.
    expect(states[gone]).toBe(DownloadState.FAILED);
  });

  it('re-verify: one the user resumed from the browser meanwhile is adopted as downloading', async () => {
    const browser = fakeBrowser();
    const api = createFakeBrowserApi();
    const storage = { session: api.storage.session, local: api.storage.local };
    const first = new DownloadManager(settings(), engines(browserEngine));
    await carryDownloads(first, storage);
    const taskId = first.enqueue(candidate());
    await flush();
    first.command(taskId, 'pause');
    await flush();

    browser.search.mockImplementation(async (id: number) => ({
      id,
      state: 'in_progress' as const,
      bytesReceived: 50,
      totalBytes: 100,
      paused: false,
    }));
    const second = new DownloadManager(settings(), engines(browserEngine));
    await carryDownloads(second, storage);
    expect(second.list()[0]?.state).toBe(DownloadState.DOWNLOADING);
    // And its completion is recorded, not ignored.
    await second.handleBrowserDownloadChanged({ id: 100, state: 'complete' });
    expect(second.list()[0]?.state).toBe(DownloadState.COMPLETED);
  });
});

describe('pass 2: duplicates, browser-side stops, retries, file names', () => {
  function dashRung(id: string): MediaVariant {
    // Every DASH representation shares the MPD's URL; only its id tells them apart.
    return {
      id,
      url: 'https://cdn.example/v/manifest.mpd',
      kind: 'video',
      protocol: 'dash',
      format: 'mp4',
      tracks: { video: true, audio: false },
    };
  }

  it('regression: another rendition of the same DASH manifest is not a duplicate', () => {
    fakeBrowser();
    const { engine, runs } = manualEngine();
    const manager = new DownloadManager(settings({ concurrentDownloads: 4 }), engines(engine));
    const mpd = candidate({ url: 'https://cdn.example/v/manifest.mpd', protocol: 'dash' });

    const first = manager.enqueue(mpd, dashRung('1080'));
    const second = manager.enqueue(mpd, dashRung('720'));
    const again = manager.enqueue(mpd, dashRung('1080'));

    expect(second).not.toBe(first);
    expect(again).toBe(first);
    expect(runs).toHaveLength(2);
  });

  it('regression: a different video with the same file name is not a duplicate', () => {
    fakeBrowser();
    const { engine, runs } = manualEngine();
    const manager = new DownloadManager(settings({ concurrentDownloads: 4 }), engines(engine));

    const a = manager.enqueue(candidate({ url: 'https://cdn.example/v/111/1080p/index.m3u8' }));
    const b = manager.enqueue(candidate({ url: 'https://cdn.example/v/222/1080p/index.m3u8' }));
    const signedAgain = manager.enqueue(
      candidate({ url: 'https://cdn.example/v/111/1080p/index.m3u8?token=fresh' }),
    );

    expect(b).not.toBe(a);
    expect(signedAgain).toBe(a);
    expect(runs).toHaveLength(2);
  });

  it("regression: cancelling in the browser's own list cancels the task, with no Retry", async () => {
    fakeBrowser();
    const manager = new DownloadManager(settings(), engines(browserEngine));
    manager.enqueue(candidate());
    await flush();

    await manager.handleBrowserDownloadChanged({
      id: 100,
      state: 'interrupted',
      error: 'USER_CANCELED',
    });
    const [task] = manager.list();
    expect(task?.state).toBe(DownloadState.CANCELLED);
    expect(task?.error).toBeUndefined();
  });

  it('regression: a full disk is reported as a disk error, not a network failure', async () => {
    fakeBrowser();
    const manager = new DownloadManager(settings(), engines(browserEngine));
    manager.enqueue(candidate());
    await flush();

    await manager.handleBrowserDownloadChanged({
      id: 100,
      state: 'interrupted',
      error: 'FILE_NO_SPACE',
    });
    const [task] = manager.list();
    expect(task?.state).toBe(DownloadState.FAILED);
    expect(task?.error?.code).toBe(ErrorCode.DISK_ERROR);
  });

  it('regression: a segmented download is not rerun whole after its segments exhausted their retries', async () => {
    fakeBrowser();
    const { engine, runs } = manualEngine();
    const segmented: DownloadEngine = { ...engine, retriesItself: true };
    const manager = new DownloadManager(settings({ retryCount: 3 }), engines(segmented));

    manager.enqueue(candidate({ url: 'https://cdn.example/a/index.m3u8', protocol: 'hls' }));
    runs[0]?.fail(new MediaGrabError(ErrorCode.SEGMENT_FAILED, 'segment 7 failed 4 times'));
    await flush();

    expect(runs).toHaveLength(1);
    expect(manager.list()[0]?.state).toBe(DownloadState.FAILED);
  });

  it('regression: renames through the naming settings once the playlist says what the file is', async () => {
    fakeBrowser();
    const { engine, runs } = manualEngine();
    const manager = new DownloadManager(
      settings({ namingTemplate: '{title} ({ext})' }),
      engines(engine),
    );

    manager.enqueue(candidate({ url: 'https://cdn.example/a/index.m3u8', protocol: 'hls' }));
    const saved = runs[0]?.run.rename('mp4');

    expect(saved).toMatch(/Feature \(mp4\)\.mp4$/);
    expect(manager.list()[0]?.filename).toBe(saved);
  });

  it('regression: a Firefox pause (interrupted, USER_CANCELED, paused) is a pause, not a cancel', async () => {
    const browser = fakeBrowser();
    const manager = new DownloadManager(settings(), engines(browserEngine));
    const taskId = manager.enqueue(candidate());
    await flush();

    manager.command(taskId, 'pause');
    await manager.handleBrowserDownloadChanged({
      id: 100,
      state: 'interrupted',
      error: 'USER_CANCELED',
      paused: true,
    });

    expect(manager.list()[0]?.state).toBe(DownloadState.PAUSED);
    expect(browser.cancel).not.toHaveBeenCalled();
  });

  it('asks the browser when an interruption does not say whether it is a pause', async () => {
    const browser = fakeBrowser();
    browser.search.mockResolvedValue({
      id: 100,
      state: 'interrupted',
      bytesReceived: 10,
      totalBytes: 100,
      paused: true,
    });
    const manager = new DownloadManager(settings(), engines(browserEngine));
    manager.enqueue(candidate());
    await flush();

    await manager.handleBrowserDownloadChanged({
      id: 100,
      state: 'interrupted',
      error: 'USER_CANCELED',
    });
    expect(manager.list()[0]?.state).toBe(DownloadState.PAUSED);
    expect(browser.cancel).not.toHaveBeenCalled();
  });

  it("regression: pausing and resuming in the browser's own list shows in the task and frees the slot", async () => {
    const browser = fakeBrowser();
    const manager = new DownloadManager(
      settings({ concurrentDownloads: 1 }),
      engines(browserEngine),
    );
    manager.enqueue(candidate());
    manager.enqueue(candidate({ url: 'https://cdn.example/second.mp4' }));
    await flush();

    await manager.handleBrowserDownloadChanged({ id: 100, paused: true });
    await flush();
    const states = () =>
      manager
        .list()
        .map((task) => task.state)
        .sort();
    expect(states()).toEqual([DownloadState.DOWNLOADING, DownloadState.PAUSED]);

    browser.search.mockResolvedValue({
      id: 100,
      state: 'in_progress',
      bytesReceived: 10,
      totalBytes: 100,
      paused: false,
    });
    await manager.handleBrowserDownloadChanged({ id: 100, paused: false });
    expect(states()).toEqual([DownloadState.DOWNLOADING, DownloadState.DOWNLOADING]);
  });

  it('regression: a direct file the network dropped is retried, as the setting says', async () => {
    const browser = fakeBrowser();
    const manager = new DownloadManager(settings({ retryCount: 2 }), engines(browserEngine));
    manager.enqueue(candidate());
    await flush();

    await manager.handleBrowserDownloadChanged({
      id: 100,
      state: 'interrupted',
      error: 'NETWORK_FAILED',
    });
    await flush();
    expect(browser.download).toHaveBeenCalledTimes(2);
    expect(manager.list()[0]?.state).toBe(DownloadState.DOWNLOADING);
  });

  it("regression: closing Firefox's Save As dialog cancels, with no error", async () => {
    const browser = fakeBrowser();
    browser.download.mockRejectedValueOnce(
      new MediaGrabError(ErrorCode.CANCELLED, 'The save was cancelled.'),
    );
    const manager = new DownloadManager(settings(), engines(browserEngine));
    manager.enqueue(candidate());
    await flush();

    const [task] = manager.list();
    expect(task?.state).toBe(DownloadState.CANCELLED);
    expect(task?.error).toBeUndefined();
  });

  it('shows a finished direct file as whole, whatever the last poll read', async () => {
    fakeBrowser();
    const manager = new DownloadManager(settings(), engines(browserEngine));
    manager.enqueue(candidate());
    await flush();

    await manager.handleBrowserDownloadChanged({ id: 100, state: 'complete' });
    const progress = manager.list()[0]?.progress;
    expect(progress?.receivedBytes).toBe(progress?.totalBytes);
  });
});

describe('verification round: browser-side edge cases', () => {
  it("regression: a paused download cancelled from Firefox's Library is cancelled, not resumed", async () => {
    const browser = fakeBrowser();
    const manager = new DownloadManager(settings(), engines(browserEngine));
    const taskId = manager.enqueue(candidate());
    await flush();
    manager.command(taskId, 'pause');
    await manager.handleBrowserDownloadChanged({
      id: 100,
      state: 'interrupted',
      error: 'USER_CANCELED',
      paused: true,
    });

    // The Library's Cancel changes only `paused`; the record says interrupted.
    browser.search.mockResolvedValue({
      id: 100,
      state: 'interrupted',
      bytesReceived: 10,
      totalBytes: 100,
      paused: false,
      error: 'USER_CANCELED',
    });
    await manager.handleBrowserDownloadChanged({ id: 100, paused: false });
    expect(manager.list()[0]?.state).toBe(DownloadState.CANCELLED);
  });

  it('a finished file too small to be polled reports its size from the browser', async () => {
    const browser = fakeBrowser();
    browser.search.mockResolvedValue({
      id: 100,
      state: 'complete',
      bytesReceived: 4096,
      totalBytes: 4096,
      paused: false,
    });
    const manager = new DownloadManager(settings(), engines(browserEngine));
    manager.enqueue(candidate());
    await flush();
    await manager.handleBrowserDownloadChanged({ id: 100, state: 'complete' });
    expect(manager.list()[0]?.progress.receivedBytes).toBe(4096);
  });
});
