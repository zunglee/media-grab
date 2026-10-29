/**
 * D16: what survives a worker restart, an extension update and a browser
 * restart. Each test plays the old worker with one manager, "kills" it, and
 * lets a second manager take charge of what was saved - the same thing a new
 * service worker does. The browser's download records come from a fake.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeLeftoverDocument,
  closeOffscreenWhenIdle,
} from '../../src/background/offscreen-lifetime.ts';
import { carryDownloads, hasSavedDownloads } from '../../src/background/queue-store.ts';
import type { BrowserApi, DownloadItemInfo } from '../../src/browser/api.ts';
import { __setBrowserApi } from '../../src/browser/index.ts';
import {
  DownloadState,
  type DownloadStrategy,
  type DownloadTaskView,
} from '../../src/core/download-types.ts';
import { ErrorCode, MediaGrabError } from '../../src/core/errors.ts';
import type { MediaCandidate } from '../../src/core/types.ts';
import type { DownloadEngine, EngineRun, Handoff } from '../../src/downloads/engines.ts';
import { DownloadManager } from '../../src/downloads/manager.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../src/storage/settings.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';
import { offeredCommands } from '../../src/ui/lib/download-view.ts';

function settings(patch: Partial<Settings['downloads']> = {}): Settings {
  return { ...DEFAULT_SETTINGS, downloads: { ...DEFAULT_SETTINGS.downloads, ...patch } };
}

let sequence = 0;
function candidate(overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  sequence += 1;
  return {
    id: `c${sequence}`,
    url: `https://cdn.example/${sequence}.mp4?token=secret`,
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

function hls(): MediaCandidate {
  return candidate({
    url: `https://cdn.example/${sequence + 1}/index.m3u8?token=secret`,
    protocol: 'hls',
    format: 'ts',
    variants: [],
  });
}

/** An engine whose attempts the test finishes, or fails, by hand. */
function manualEngine(browserFetches: boolean) {
  const runs: Array<{
    run: EngineRun;
    finish: (h: Handoff) => void;
    fail: (err: unknown) => void;
  }> = [];
  const engine: DownloadEngine = {
    browserFetches,
    retriesItself: !browserFetches,
    start: (run) =>
      new Promise<Handoff>((resolve, reject) => {
        runs.push({ run, finish: resolve, fail: reject });
      }),
  };
  return { engine, runs };
}

function world() {
  const api = createFakeBrowserApi();
  const records = new Map<number, DownloadItemInfo>();
  api.downloads.search = vi.fn(async (id: number) => records.get(id));
  __setBrowserApi(api as BrowserApi);
  const direct = manualEngine(true);
  const segmented = manualEngine(false);
  const engines: Record<DownloadStrategy, DownloadEngine> = {
    'browser-download': direct.engine,
    'segment-hls': segmented.engine,
    'segment-dash': segmented.engine,
  };
  const storage = { session: api.storage.session, local: api.storage.local };
  const worker = async (slots = 3, patch: Partial<Settings['downloads']> = {}) => {
    const manager = new DownloadManager(
      settings({ concurrentDownloads: slots, ...patch }),
      engines,
    );
    await carryDownloads(manager, storage);
    return manager;
  };
  /** An extension update or a browser restart: the browser clears session storage. */
  const clearSession = async () => {
    for (const key of ['downloads:queue', 'downloads:paused'])
      await api.storage.session.remove(key);
  };
  return { api, records, direct, segmented, engines, storage, worker, clearSession };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const byId = (tasks: DownloadTaskView[]) =>
  Object.fromEntries(tasks.map((task) => [task.id, task]));

afterEach(() => __setBrowserApi(null));

describe('D16: a worker restart loses nothing', () => {
  it('queued tasks run again, and a download caught mid-fetch says so and can be retried', async () => {
    const w = world();
    const before = await w.worker(1);
    const fetching = before.enqueue(hls());
    const waiting = before.enqueue(candidate());
    await flush();
    expect(w.segmented.runs).toHaveLength(1); // the HLS task holds the only slot

    const after = await w.worker(1); // the old worker is gone, mid-fetch
    const tasks = byId(after.list());
    expect(tasks[fetching]?.state).toBe(DownloadState.FAILED);
    expect(tasks[fetching]?.error?.code).toBe(ErrorCode.INTERRUPTED);
    expect(offeredCommands(tasks[fetching] as DownloadTaskView)).toContain('retry');
    // The waiting task took the freed slot in the new worker.
    expect(tasks[waiting]?.state).toBe(DownloadState.DOWNLOADING);
    expect(w.direct.runs).toHaveLength(1);
  });

  it('a file that finished while no worker ran is completed - and reaches history', async () => {
    const w = world();
    const before = await w.worker();
    const id = before.enqueue(hls());
    await flush();
    w.segmented.runs[0]?.run.onVerifying();
    w.segmented.runs[0]?.finish({ browserDownloadId: 7 });
    await flush();

    w.records.set(7, {
      id: 7,
      state: 'complete',
      bytesReceived: 900,
      totalBytes: 900,
      paused: false,
    });
    const completed = vi.fn();
    const after = new DownloadManager(settings(), {
      'browser-download': w.direct.engine,
      'segment-hls': w.segmented.engine,
      'segment-dash': w.segmented.engine,
    });
    after.onTaskCompleted(completed); // download-hooks attaches before the restore
    await carryDownloads(after, w.storage);

    expect(byId(after.list())[id]?.state).toBe(DownloadState.COMPLETED);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(byId(after.list())[id]?.progress.receivedBytes).toBe(900);
  });

  it('a direct file still running in the browser is followed, not restarted', async () => {
    const w = world();
    const before = await w.worker();
    const id = before.enqueue(candidate());
    await flush();
    w.direct.runs[0]?.finish({ browserDownloadId: 3 });
    await flush();

    w.records.set(3, {
      id: 3,
      state: 'in_progress',
      bytesReceived: 10,
      totalBytes: 100,
      paused: false,
    });
    const after = await w.worker();
    expect(byId(after.list())[id]?.state).toBe(DownloadState.DOWNLOADING);
    expect(w.direct.runs).toHaveLength(1); // no second download
  });

  it('reads the 0.1.5 paused-downloads key once, then drops it', async () => {
    const w = world();
    const before = await w.worker();
    const id = before.enqueue(candidate());
    await flush();
    w.direct.runs[0]?.finish({ browserDownloadId: 4 });
    await flush();
    before.command(id, 'pause');
    await flush();
    const legacy = before.records();
    await w.api.storage.session.remove('downloads:queue');
    await w.api.storage.session.set('downloads:paused', legacy);

    w.records.set(4, {
      id: 4,
      state: 'in_progress',
      bytesReceived: 5,
      totalBytes: 10,
      paused: true,
    });
    const after = await w.worker();
    expect(byId(after.list())[id]?.state).toBe(DownloadState.PAUSED);
    expect(await w.api.storage.session.get('downloads:paused')).toBeUndefined();
  });
});

describe('D16: an update or a browser restart leaves a trace, without URLs', () => {
  it('keeps no URL on disk', async () => {
    const w = world();
    const before = await w.worker();
    before.enqueue(candidate());
    before.enqueue(hls());
    await flush();
    const trace = JSON.stringify(await w.api.storage.local.get('downloads:trace'));
    expect(trace).not.toContain('https://');
    expect(trace).not.toContain('token');
  });

  it('a file the browser still holds is followed by its id; nothing can be retried', async () => {
    const w = world();
    const before = await w.worker();
    const running = before.enqueue(candidate());
    const queued = before.enqueue(hls());
    await flush();
    w.direct.runs[0]?.finish({ browserDownloadId: 9 });
    await flush();

    await w.clearSession();
    w.records.set(9, {
      id: 9,
      state: 'in_progress',
      bytesReceived: 50,
      totalBytes: 100,
      paused: false,
    });
    const after = await w.worker();
    const tasks = byId(after.list());

    expect(tasks[running]?.state).toBe(DownloadState.DOWNLOADING);
    expect(tasks[running]?.canRetry).toBe(false);

    // The HLS task was mid-fetch: interrupted, and with no address kept, no Retry.
    expect(tasks[queued]?.state).toBe(DownloadState.FAILED);
    expect(tasks[queued]?.error?.code).toBe(ErrorCode.INTERRUPTED);
    expect(offeredCommands(tasks[queued] as DownloadTaskView)).not.toContain('retry');
    expect(after.command(queued, 'retry')).toBe(false);

    // A task followed by id still pauses and cancels through the browser.
    expect(after.command(running, 'pause')).toBe(true);
  });

  it('a finished trace clears itself', async () => {
    const w = world();
    const before = await w.worker();
    const id = before.enqueue(candidate());
    await flush();
    w.direct.runs[0]?.finish({ browserDownloadId: 11 });
    await flush();
    await before.handleBrowserDownloadChanged({ id: 11, state: 'complete' });
    await flush();
    expect(await w.api.storage.local.get('downloads:trace')).toEqual([]);
    expect(byId(before.list())[id]?.state).toBe(DownloadState.COMPLETED);
  });
});

describe('D16: saving', () => {
  it('writes when a task changes state, not on every progress reading', async () => {
    const w = world();
    const before = await w.worker();
    before.enqueue(hls());
    await flush();
    const set = vi.spyOn(w.api.storage.session, 'set');
    for (let i = 1; i <= 20; i += 1)
      w.segmented.runs[0]?.run.onProgress({ receivedBytes: i * 100 });
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the progress emit fire
    expect(set).not.toHaveBeenCalled();
  });

  it('knows whether a new worker has anything to take charge of', async () => {
    const w = world();
    expect(await hasSavedDownloads(w.storage)).toBe(false);
    const before = await w.worker();
    before.enqueue(candidate());
    await flush();
    expect(await hasSavedDownloads(w.storage)).toBe(true);
  });
});

describe('D16: the offscreen document is closed when nothing needs it', () => {
  function tasks(...states: Array<[DownloadStrategy, DownloadState]>): DownloadTaskView[] {
    return states.map(
      ([strategy, state], index) => ({ id: `t${index}`, strategy, state }) as DownloadTaskView,
    );
  }

  it('closes at start (a killed worker may have left it open) and when the last segmented download ends', () => {
    const api = createFakeBrowserApi();
    const close = vi.fn(async () => undefined);
    api.offscreen = { isSupported: () => true, ensureDocument: async () => undefined, close };
    __setBrowserApi(api);

    let listener: ((list: DownloadTaskView[]) => void) | undefined;
    let current = tasks(['browser-download', DownloadState.DOWNLOADING]);
    closeOffscreenWhenIdle({
      list: () => current,
      onChange: (next) => {
        listener = next;
        return () => undefined;
      },
    });
    expect(close).toHaveBeenCalledTimes(1);

    current = tasks(['segment-hls', DownloadState.DOWNLOADING]);
    listener?.(current);
    current = tasks(['segment-hls', DownloadState.VERIFYING]);
    listener?.(current);
    expect(close).toHaveBeenCalledTimes(1); // busy: never closed under a download

    current = tasks(['segment-hls', DownloadState.COMPLETED]);
    listener?.(current);
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('re-audit of D16', () => {
  it('a task recovered from a trace survives the next worker restart too', async () => {
    const w = world();
    const before = await w.worker();
    const id = before.enqueue(candidate());
    await flush();
    w.direct.runs[0]?.finish({ browserDownloadId: 9 });
    await flush();

    await w.clearSession(); // an update
    w.records.set(9, {
      id: 9,
      state: 'in_progress',
      bytesReceived: 5,
      totalBytes: 10,
      paused: true,
    });
    await w.worker(); // recovers it from the trace, then goes idle
    await flush();

    const later = await w.worker(); // the next worker restart
    expect(byId(later.list())[id]?.state).toBe(DownloadState.PAUSED);
    expect(byId(later.list())[id]?.canRetry).toBe(false);
  });

  it('a failed row keeps its "Allow <host>" offer across a worker restart', async () => {
    const w = world();
    w.api.permissions.contains = async () => false;
    const before = await w.worker(3, { retryCount: 0 });
    const id = before.enqueue(candidate());
    await flush();
    w.direct.runs[0]?.fail(
      new MediaGrabError(ErrorCode.STREAM_EXPIRED, 'HTTP 403', { host: 'cdn.example' }),
    );
    await flush();
    await flush();
    expect(byId(before.list())[id]?.error?.accessHost).toBe('cdn.example');

    const after = await w.worker();
    expect(byId(after.list())[id]?.error?.accessHost).toBe('cdn.example');
  });

  it('bringing the queue back never runs more downloads than the settings allow', async () => {
    const w = world();
    const before = await w.worker(3);
    const dropped = before.enqueue(candidate());
    const running = before.enqueue(candidate());
    await flush();
    w.direct.runs[0]?.finish({ browserDownloadId: 1 });
    w.direct.runs[1]?.finish({ browserDownloadId: 2 });
    await flush();

    // The browser dropped the first file (a network error: worth a retry) and
    // is still writing the second.
    w.records.set(1, {
      id: 1,
      state: 'interrupted',
      bytesReceived: 0,
      totalBytes: 10,
      paused: false,
      error: 'NETWORK_FAILED',
    });
    w.records.set(2, {
      id: 2,
      state: 'in_progress',
      bytesReceived: 5,
      totalBytes: 10,
      paused: false,
    });
    const after = await w.worker(1);
    const tasks = byId(after.list());
    expect(tasks[running]?.state).toBe(DownloadState.DOWNLOADING);
    expect(tasks[dropped]?.state).toBe(DownloadState.QUEUED);
    expect(after.list().filter((task) => task.state === DownloadState.DOWNLOADING)).toHaveLength(1);
  });

  it("a killed worker's offscreen document is closed before the restore - unless the browser is writing from it", async () => {
    const api = createFakeBrowserApi();
    const close = vi.fn(async () => undefined);
    api.offscreen = { isSupported: () => true, ensureDocument: async () => undefined, close };
    __setBrowserApi(api);
    const segmented = (state: 'in_progress' | 'complete') => ({
      trace: {
        id: 't',
        filename: 'x.ts',
        kind: 'video' as const,
        strategy: 'segment-hls' as const,
        state: DownloadState.DOWNLOADING,
        createdAt: 0,
        browserDownloadId: 4,
      },
      browser: { id: 4, state, bytesReceived: 1, totalBytes: 2, paused: false },
    });

    await closeLeftoverDocument([segmented('complete')]);
    expect(close).toHaveBeenCalledTimes(1);
    await closeLeftoverDocument([segmented('in_progress')]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('verification: a retry after a worker restart still names the page to the host the row offered', async () => {
    const w = world();
    w.api.permissions.contains = async () => false;
    const before = await w.worker(3, { retryCount: 0 });
    const id = before.enqueue(candidate());
    await flush();
    w.direct.runs[0]?.fail(
      new MediaGrabError(ErrorCode.STREAM_EXPIRED, 'HTTP 403', { host: 'edge.other-cdn.example' }),
    );
    await flush();
    await flush();

    const hold = vi.fn(async () => () => undefined);
    const after = new DownloadManager(settings(), w.engines, { hold });
    await carryDownloads(after, w.storage);
    expect(after.command(id, 'retry')).toBe(true);
    await flush();
    w.direct.runs.at(-1)?.run.willFetch([w.direct.runs.at(-1)?.run.request.url ?? '']);
    await flush();
    expect(hold).toHaveBeenLastCalledWith(
      expect.arrayContaining(['https://edge.other-cdn.example/']),
      'https://site.example/watch',
    );
  });

  it('verification: a failing write is tried again after a pause, not on every change', async () => {
    vi.useFakeTimers();
    try {
      const w = world();
      const set = vi.fn(async () => {
        throw new Error('QUOTA_BYTES quota exceeded');
      });
      w.api.storage.session.set = set;
      const manager = await w.worker();
      const calls = set.mock.calls.length;
      manager.enqueue(candidate());
      manager.enqueue(candidate());
      await vi.advanceTimersByTimeAsync(100);
      expect(set.mock.calls.length).toBe(calls); // waiting for the retry
      await vi.advanceTimersByTimeAsync(5_000);
      expect(set.mock.calls.length).toBe(calls + 1); // one write, with the latest queue
    } finally {
      vi.useRealTimers();
    }
  });

  it('final check: a change made just as a save finishes is still saved', async () => {
    // Whatever microtask the change lands in after the first write completes.
    const lost: number[] = [];
    for (let depth = 0; depth < 25; depth += 1) {
      const api = createFakeBrowserApi();
      __setBrowserApi(api as BrowserApi);
      let state: DownloadState = DownloadState.QUEUED;
      let listener: (() => void) | undefined;
      const manager = {
        restore: () => undefined,
        records: () =>
          [{ view: { id: 't', state, filename: 'f', attempts: 0 } }] as unknown as ReturnType<
            DownloadManager['records']
          >,
        traces: () => [],
        onChange: (next: () => void) => {
          listener = next;
          return () => undefined;
        },
      };
      let release: (() => void) | undefined;
      const set = api.storage.session.set.bind(api.storage.session);
      api.storage.session.set = async (key, value) => {
        if (!release) await new Promise<void>((resolve) => (release = resolve));
        return set(key, value);
      };
      const carried = carryDownloads(manager as unknown as DownloadManager, {
        session: api.storage.session,
        local: api.storage.local,
      });
      await flush();
      let later: Promise<unknown> = Promise.resolve();
      for (let i = 0; i < depth; i += 1) later = later.then(() => undefined);
      void later.then(() => {
        state = DownloadState.DOWNLOADING;
        listener?.();
      });
      release?.();
      await carried;
      for (let i = 0; i < 5; i += 1) await flush();
      const stored =
        await api.storage.session.get<Array<{ view: { state: string } }>>('downloads:queue');
      if (stored?.[0]?.view.state !== DownloadState.DOWNLOADING) lost.push(depth);
    }
    expect(lost).toEqual([]);
  });
});
