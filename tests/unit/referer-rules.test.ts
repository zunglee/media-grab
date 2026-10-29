/**
 * D18: the page as Referer on MediaGrab's own requests, through session header
 * rules - set for the hosts a task fetches from, shared between tasks, removed
 * with the last one - and the failed row's "Allow <host> and retry".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundServices } from '../../src/background/services.ts';
import type { BrowserApi } from '../../src/browser/api.ts';
import { __setBrowserApi } from '../../src/browser/index.ts';
import { DownloadState, type DownloadStrategy } from '../../src/core/download-types.ts';
import { ErrorCode, MediaGrabError } from '../../src/core/errors.ts';
import type { MediaCandidate } from '../../src/core/types.ts';
import type { DownloadEngine, EngineRun, Handoff } from '../../src/downloads/engines.ts';
import { DownloadManager } from '../../src/downloads/manager.ts';
import { RefererRules } from '../../src/downloads/referer-rules.ts';
import { DEFAULT_SETTINGS } from '../../src/storage/settings.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';
import { accessOffer } from '../../src/ui/lib/download-view.ts';

/** A browser whose session rules we can inspect. */
function browserWithRules(granted: string[] = []) {
  const api = createFakeBrowserApi();
  const rules = new Map<number, { host: string; referer: string }>();
  api.headerRules = {
    isSupported: () => true,
    setReferer: vi.fn(async ({ id, host, referer }) => {
      rules.set(id, { host, referer });
    }),
    remove: vi.fn(async (ids: number[]) => {
      for (const id of ids) rules.delete(id);
    }),
    ids: async () => [...rules.keys()],
  };
  api.permissions.contains = async (origins: string[]) =>
    origins.every((origin) => granted.includes(origin));
  __setBrowserApi(api as BrowserApi);
  return { api, rules };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => __setBrowserApi(null));

describe('D18: Referer rules', () => {
  it('names the page to each host a task fetches from, once per host', async () => {
    const { rules } = browserWithRules();
    const referers = new RefererRules();
    await referers.hold(
      ['https://cdn.example/a.ts', 'https://cdn.example/b.ts', 'https://img.example/c.ts'],
      'https://site.example/watch/1',
    );
    expect([...rules.values()]).toEqual([
      { host: 'cdn.example', referer: 'https://site.example/watch/1' },
      { host: 'img.example', referer: 'https://site.example/watch/1' },
    ]);
  });

  it('keeps a host rule while any task still uses it, and removes it with the last', async () => {
    const { rules } = browserWithRules();
    const referers = new RefererRules();
    const first = await referers.hold(['https://cdn.example/1.mp4'], 'https://site.example/a');
    const second = await referers.hold(['https://cdn.example/2.mp4'], 'https://site.example/b');
    expect([...rules.values()]).toEqual([
      { host: 'cdn.example', referer: 'https://site.example/b' },
    ]);

    first();
    await flush();
    expect(rules.size).toBe(1);
    second();
    second(); // twice is harmless
    await flush();
    expect(rules.size).toBe(0);
  });

  it("clears a killed worker's leftover rules before setting its own", async () => {
    const { rules } = browserWithRules();
    rules.set(41, { host: 'old.example', referer: 'https://gone.example/' });
    await new RefererRules().hold(['https://cdn.example/x.mp4'], 'https://site.example/');
    expect([...rules.values()].map((rule) => rule.host)).toEqual(['cdn.example']);
  });

  it('never names a non-http page or targets a non-http URL', async () => {
    const { rules } = browserWithRules();
    const referers = new RefererRules();
    await referers.hold(['https://cdn.example/x.mp4'], 'chrome-extension://abc/popup.html');
    await referers.hold(
      ['blob:https://site.example/1', 'data:video/mp4,AA'],
      'https://site.example/',
    );
    expect(rules.size).toBe(0);
  });
});

function candidate(): MediaCandidate {
  return {
    id: 'c1',
    url: 'https://cdn.example/feature.mp4',
    pageUrl: 'https://site.example/watch',
    kind: 'video',
    protocol: 'progressive',
    format: 'mp4',
    source: 'dom-element',
    seenAt: 1,
    tracks: { video: true, audio: true },
  };
}

/** An engine that names its host, then fails or succeeds as told. */
function engine(outcome: () => Promise<Handoff>) {
  const runs: EngineRun[] = [];
  const e: DownloadEngine = {
    browserFetches: true,
    retriesItself: false,
    start: async (run) => {
      runs.push(run);
      await run.willFetch([run.request.url]);
      return outcome();
    },
  };
  const engines: Record<DownloadStrategy, DownloadEngine> = {
    'browser-download': e,
    'segment-hls': e,
    'segment-dash': e,
  };
  return { engines, runs };
}

describe('D18: the manager holds Referer rules for the life of a task', () => {
  it('holds them until the file is complete', async () => {
    browserWithRules();
    const hold = vi.fn(async () => release);
    const release = vi.fn();
    const { engines } = engine(async () => ({ browserDownloadId: 5 }));
    const manager = new DownloadManager(DEFAULT_SETTINGS, engines, { hold });
    manager.enqueue(candidate());
    await flush();
    expect(hold).toHaveBeenCalledWith(
      ['https://cdn.example/feature.mp4'],
      'https://site.example/watch',
    );
    expect(release).not.toHaveBeenCalled();

    await manager.handleBrowserDownloadChanged({ id: 5, state: 'complete' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('offers to allow the refusing host when MediaGrab has no access to it', async () => {
    browserWithRules([]);
    const { engines } = engine(async () => {
      throw new MediaGrabError(ErrorCode.STREAM_EXPIRED, 'HTTP 403', { host: 'cdn.example' });
    });
    const manager = new DownloadManager(
      { ...DEFAULT_SETTINGS, downloads: { ...DEFAULT_SETTINGS.downloads, retryCount: 0 } },
      engines,
      { hold: async () => () => undefined },
    );
    manager.enqueue(candidate());
    await flush();
    await flush();
    const [task] = manager.list();
    expect(task?.state).toBe(DownloadState.FAILED);
    expect(task && accessOffer(task)).toBe('cdn.example');
  });

  it('does not offer a grant that would not help', async () => {
    browserWithRules(['https://cdn.example/*']); // already allowed: the Referer was sent
    const { engines } = engine(async () => {
      throw new MediaGrabError(ErrorCode.STREAM_EXPIRED, 'HTTP 403', { host: 'cdn.example' });
    });
    const manager = new DownloadManager(
      { ...DEFAULT_SETTINGS, downloads: { ...DEFAULT_SETTINGS.downloads, retryCount: 0 } },
      engines,
      { hold: async () => () => undefined },
    );
    manager.enqueue(candidate());
    await flush();
    await flush();
    const [task] = manager.list();
    expect(task && accessOffer(task)).toBeUndefined();
  });
});

describe('re-audit of D18', () => {
  it('a rule that arrives after the task settled is released at once', async () => {
    browserWithRules();
    let resolveHold: (release: () => void) => void = () => undefined;
    const hold = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveHold = resolve;
        }),
    );
    const release = vi.fn();
    const { engines } = engine(async () => new Promise<Handoff>(() => undefined));
    const manager = new DownloadManager(DEFAULT_SETTINGS, engines, { hold });
    const id = manager.enqueue(candidate());
    await flush();
    manager.command(id, 'cancel'); // while the rule is still being set
    resolveHold(release);
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a retry names the page to the host that refused after a redirect', async () => {
    browserWithRules([]);
    const hold = vi.fn(async () => () => undefined);
    let attempts = 0;
    const { engines } = engine(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new MediaGrabError(ErrorCode.STREAM_EXPIRED, 'HTTP 403', {
          host: 'edge.other-cdn.example',
        });
      }
      return new Promise<Handoff>(() => undefined);
    });
    const manager = new DownloadManager(
      { ...DEFAULT_SETTINGS, downloads: { ...DEFAULT_SETTINGS.downloads, retryCount: 0 } },
      engines,
      { hold },
    );
    const id = manager.enqueue(candidate());
    await flush();
    await flush();
    expect(manager.command(id, 'retry')).toBe(true);
    await flush();
    expect(hold).toHaveBeenLastCalledWith(
      ['https://cdn.example/feature.mp4', 'https://edge.other-cdn.example/'],
      'https://site.example/watch',
    );
  });

  it('offers the grant when only the other scheme is allowed', async () => {
    browserWithRules(['http://cdn.example/*']); // the task fetches over https
    const { engines } = engine(async () => {
      throw new MediaGrabError(ErrorCode.STREAM_EXPIRED, 'HTTP 403', { host: 'cdn.example' });
    });
    const manager = new DownloadManager(
      { ...DEFAULT_SETTINGS, downloads: { ...DEFAULT_SETTINGS.downloads, retryCount: 0 } },
      engines,
      { hold: async () => () => undefined },
    );
    manager.enqueue(candidate());
    await flush();
    await flush();
    const [task] = manager.list();
    expect(task && accessOffer(task)).toBe('cdn.example');
  });

  it('a new worker clears the old rules at start, before any download', async () => {
    const { rules } = browserWithRules();
    rules.set(7, { host: 'old.example', referer: 'https://gone.example/' });
    // The old page must stop being named even though nothing downloads.
    await new BackgroundServices().downloads();
    expect(rules.size).toBe(0);
  });
});
