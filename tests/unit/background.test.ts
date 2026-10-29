/**
 * The worker's detection flow: how frame reports become tab state, how scans
 * are coalesced, who may send what, and where a navigation starts. The tests
 * marked "regression" were real bugs in 0.1.3.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageRouter } from '../../src/background/message-router.ts';
import { Scanner } from '../../src/background/scanner.ts';
import { BackgroundServices } from '../../src/background/services.ts';
import {
  applyReport,
  EMPTY_CONTEXT,
  type FrameReport,
  TabStore,
  tabSignals,
} from '../../src/background/tab-store.ts';
import type { BrowserApi, WebRequestDetails } from '../../src/browser/api.ts';
import { __setBrowserApi } from '../../src/browser/index.ts';
import { ErrorCode } from '../../src/core/errors.ts';
import { fetchManifestText } from '../../src/core/fetch.ts';
import type { PageReport } from '../../src/core/messages.ts';
import type { MediaCandidate, PageSignals } from '../../src/core/types.ts';
import { makeCandidate } from '../../src/detection/candidate.ts';
import { NetworkObserver } from '../../src/detection/network.ts';
import { fetchSegments } from '../../src/downloads/segment-fetcher.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';

const PAGE = 'https://site.example/watch/1';

function media(url: string): MediaCandidate {
  return makeCandidate({
    url,
    pageUrl: PAGE,
    pageTitle: 'Page',
    kind: 'video',
    source: 'dom-element',
  });
}

/** When the page in these tests began; a different value is a different page. */
const LOADED_AT = 1_000_000;

function signals(overrides: Partial<PageSignals> = {}): PageSignals {
  return {
    hasMediaSource: false,
    hasMediaKeys: false,
    mediaElements: 1,
    playerFrames: 0,
    ...overrides,
  };
}

/** A frame's report as the tab store receives it: claims already rebuilt into candidates. */
function report(overrides: Partial<FrameReport> = {}): FrameReport {
  return {
    pageUrl: PAGE,
    pageTitle: 'Watch one',
    routeStartedAt: LOADED_AT,
    signals: signals(),
    candidates: [],
    ...overrides,
  };
}

/** A report as a content script sends it: claims, not candidates. */
function wireReport(overrides: Partial<PageReport> = {}): PageReport {
  return {
    pageUrl: PAGE,
    pageTitle: 'Watch one',
    routeStartedAt: LOADED_AT,
    signals: signals(),
    candidates: [],
    ...overrides,
  };
}

function installFakeBrowser(): BrowserApi {
  const api = createFakeBrowserApi();
  __setBrowserApi(api);
  return api;
}

afterEach(() => {
  __setBrowserApi(null);
});

describe('re-audit 0.1.6: one URL claimed twice in a report', () => {
  it('keeps what the element knew (title, poster) when the fetched copy comes last', () => {
    const url = `${PAGE}/played.m3u8`;
    const element = makeCandidate({
      url,
      pageUrl: PAGE,
      pageTitle: 'Page',
      kind: 'video',
      source: 'dom-element',
      title: 'The Feature',
      posterUrl: `${PAGE}/poster.jpg`,
    });
    const fetched = makeCandidate({ url, pageUrl: PAGE, kind: 'video', source: 'page-hook' });
    expect(fetched.id).toBe(element.id);

    const { context } = applyReport(EMPTY_CONTEXT, 0, report({ candidates: [element, fetched] }));
    const [only] = context.pageCandidates;
    expect(context.pageCandidates).toHaveLength(1);
    expect(only?.title).toBe('The Feature');
    expect(only?.posterUrl).toBe(`${PAGE}/poster.jpg`);
  });
});

describe('folding frame reports into tab state', () => {
  it('lets the top frame set the page', () => {
    const { context, navigated } = applyReport(EMPTY_CONTEXT, 0, report());
    expect(context.pageUrl).toBe(PAGE);
    expect(context.pageTitle).toBe('Watch one');
    expect(navigated).toBe(false);
  });

  it('regression: an iframe report is not a navigation and does not replace the page', () => {
    const top = applyReport(EMPTY_CONTEXT, 0, report({ candidates: [media(`${PAGE}/a.mp4`)] }));
    const { context, navigated } = applyReport(
      top.context,
      7,
      report({
        pageUrl: 'https://player.example/embed/9',
        pageTitle: 'Embedded player',
        candidates: [media('https://player.example/b.mp4')],
      }),
    );
    expect(navigated).toBe(false);
    expect(context.pageUrl).toBe(PAGE);
    expect(context.pageTitle).toBe('Watch one');
    expect(context.pageCandidates.map((c) => c.frameId).sort()).toEqual([0, 7]);
  });

  it("adds an iframe player's signals to the tab", () => {
    const top = applyReport(EMPTY_CONTEXT, 0, report());
    const { context } = applyReport(
      top.context,
      3,
      report({ signals: signals({ hasMediaKeys: true, mediaElements: 2 }) }),
    );
    expect(tabSignals(context)).toMatchObject({ hasMediaKeys: true, mediaElements: 3 });
  });

  it("replaces a frame's earlier candidates with its latest report", () => {
    const first = applyReport(EMPTY_CONTEXT, 0, report({ candidates: [media(`${PAGE}/a.mp4`)] }));
    const second = applyReport(first.context, 0, report({ candidates: [media(`${PAGE}/b.mp4`)] }));
    expect(second.context.pageCandidates.map((c) => c.url)).toEqual([`${PAGE}/b.mp4`]);
  });

  it('re-review: a fragment change is not a navigation and keeps iframe media', () => {
    const top = applyReport(EMPTY_CONTEXT, 0, report());
    const framed = applyReport(top.context, 4, report({ candidates: [media(`${PAGE}/c.mp4`)] }));
    const { context, navigated } = applyReport(
      framed.context,
      0,
      report({ pageUrl: `${PAGE}#t=90` }),
    );
    expect(navigated).toBe(false);
    expect(context.pageCandidates.map((c) => c.url)).toEqual([`${PAGE}/c.mp4`]);
  });

  it('drops everything about the previous page when the top frame navigates', () => {
    const before = applyReport(
      EMPTY_CONTEXT,
      0,
      report({
        signals: signals({ hasMediaSource: true }),
        candidates: [media(`${PAGE}/a.mp4`)],
      }),
    );
    const iframe = applyReport(before.context, 4, report({ candidates: [media(`${PAGE}/c.mp4`)] }));
    const { context, navigated } = applyReport(
      iframe.context,
      0,
      report({
        pageUrl: 'https://site.example/watch/2',
        routeStartedAt: LOADED_AT + 5_000,
        candidates: [],
      }),
    );
    expect(navigated).toBe(true);
    expect(context.pageCandidates).toEqual([]);
    expect(tabSignals(context).hasMediaSource).toBe(false);
  });

  it('pass 2 regression: an address tidied by replaceState is the same page', () => {
    const top = applyReport(
      EMPTY_CONTEXT,
      0,
      report({ pageUrl: `${PAGE}?utm_source=x`, candidates: [media(`${PAGE}/a.mp4`)] }),
    );
    const framed = applyReport(top.context, 4, report({ candidates: [media(`${PAGE}/c.mp4`)] }));
    const { context, navigated } = applyReport(framed.context, 0, report({ pageUrl: PAGE }));
    expect(navigated).toBe(false);
    expect(context.pageUrl).toBe(PAGE);
    expect(context.pageCandidates.map((c) => c.url)).toContain(`${PAGE}/c.mp4`);
  });

  it('pass 2 regression: coming back from the back-forward cache is a navigation, same URL or not', () => {
    const top = applyReport(EMPTY_CONTEXT, 0, report());
    const framed = applyReport(top.context, 4, report({ candidates: [media(`${PAGE}/c.mp4`)] }));
    const { navigated } = applyReport(
      framed.context,
      0,
      report({ routeStartedAt: LOADED_AT + 60_000 }),
    );
    expect(navigated).toBe(true);
  });

  it("pass 2 regression: a tab over its cap keeps the reporting frame's media", () => {
    let context = EMPTY_CONTEXT;
    for (let frame = 1; frame <= 6; frame += 1) {
      const many = Array.from({ length: 200 }, (_unused, i) => media(`${PAGE}/f${frame}-${i}.mp4`));
      context = applyReport(context, frame, report({ candidates: many })).context;
    }
    const player = media(`${PAGE}/player.m3u8`);
    context = applyReport(context, 0, report({ candidates: [player] })).context;
    expect(context.pageCandidates.length).toBeLessThanOrEqual(1_000);
    expect(context.pageCandidates.some((c) => c.url === player.url)).toBe(true);
  });
});

describe('tab store', () => {
  it('regression: concurrent reports from two frames both survive', async () => {
    const api = installFakeBrowser();
    const store = new TabStore(api.storage.session);
    await Promise.all([
      store.applyReport(1, 0, report({ candidates: [media(`${PAGE}/top.mp4`)] })),
      store.applyReport(1, 5, report({ candidates: [media(`${PAGE}/frame.mp4`)] })),
    ]);
    const context = await store.context(1);
    expect(context.pageCandidates.map((c) => c.url).sort()).toEqual([
      `${PAGE}/frame.mp4`,
      `${PAGE}/top.mp4`,
    ]);
  });
});

describe('tab store after a tab closes', () => {
  it('re-review: a scan that lands after the tab closed is not written back', async () => {
    const api = installFakeBrowser();
    const store = new TabStore(api.storage.session);
    await store.forget(9);
    await store.saveScan(9, {
      tabId: 9,
      pageUrl: PAGE,
      pageTitle: 'x',
      scannedAt: 0,
      candidates: [],
      rejected: [],
      stats: {} as never,
    });
    expect(await store.lastScan(9)).toBeUndefined();
  });
});

describe('scanner', () => {
  it('runs one scan per tab at a time and shares one follow-up among late callers', async () => {
    const api = installFakeBrowser();
    const store = new TabStore(api.storage.session);
    const scanner = new Scanner(store, new NetworkObserver());
    const saveScan = vi.spyOn(store, 'saveScan');

    const first = scanner.scan(1);
    const second = scanner.scan(1);
    const third = scanner.scan(1);
    expect(second).toBe(third);

    await Promise.all([first, second, third]);
    expect(saveScan).toHaveBeenCalledTimes(2);
  });

  it('re-review: a caller whose data is older than the running scan joins it', async () => {
    const api = installFakeBrowser();
    const store = new TabStore(api.storage.session);
    const scanner = new Scanner(store, new NetworkObserver());
    const saveScan = vi.spyOn(store, 'saveScan');

    const storedAt = performance.now();
    const autoScan = scanner.scan(1);
    const scanAgain = scanner.scan(1, { notBefore: storedAt });
    expect(scanAgain).toBe(autoScan);
    await scanAgain;
    expect(saveScan).toHaveBeenCalledTimes(1);
  });
});

describe('message router', () => {
  const extensionPage = { url: '/popup.html' };
  const contentScript = { tabId: 1, frameId: 0, url: PAGE };

  it('regression: refuses to start a download on behalf of a content script', async () => {
    installFakeBrowser();
    const route = createMessageRouter(new BackgroundServices());
    const reply = route({ type: 'START_DOWNLOAD', tabId: 1, candidateId: 'x' }, contentScript);
    expect(reply).toBeUndefined();
  });

  it('refuses a page report from anything but a content script', () => {
    installFakeBrowser();
    const route = createMessageRouter(new BackgroundServices());
    expect(route({ type: 'PAGE_REPORT', ...wireReport() }, extensionPage)).toBeUndefined();
  });

  it('stores a content script report and answers once it is stored', async () => {
    installFakeBrowser();
    const services = new BackgroundServices();
    const route = createMessageRouter(services);
    const reply = await route(
      {
        type: 'PAGE_REPORT',
        ...wireReport({
          candidates: [{ url: `${PAGE}/a.mp4`, kind: 'video', source: 'dom-element' }],
        }),
      },
      contentScript,
    );
    expect(reply).toMatchObject({ stored: true, storedAt: expect.any(Number) });
    const context = await services.tabs.context(1);
    expect(context.pageCandidates).toHaveLength(1);
  });

  it('pass 2 regression: rebuilds page claims instead of storing what the page built', async () => {
    installFakeBrowser();
    const services = new BackgroundServices();
    const route = createMessageRouter(services);
    await route(
      {
        type: 'PAGE_REPORT',
        ...wireReport({
          candidates: [
            {
              url: `${PAGE}/a.m3u8`,
              kind: 'video',
              source: 'dom-element',
              // Fields a page must not be able to set:
              variants: [{ id: 'x', url: 'https://evil.example/x.m3u8' }],
              score: 100,
              drm: false,
              id: 'chosen-by-page',
            },
            { url: 'javascript:alert(1)//.mp4', kind: 'video', source: 'dom-attribute' },
            { url: `${PAGE}/b.mp4`, kind: 'video', source: 'network' },
          ] as never,
        }),
      },
      contentScript,
    );
    const [stored, ...others] = (await services.tabs.context(1)).pageCandidates;
    expect(others).toEqual([]);
    expect(stored?.url).toBe(`${PAGE}/a.m3u8`);
    expect(stored?.id).not.toBe('chosen-by-page');
    expect(stored).not.toHaveProperty('variants');
    expect(stored).not.toHaveProperty('score');
    expect(stored?.protocol).toBe('hls');
  });

  it('re-audit regression: a quality that is no longer offered is refused, not swapped for "best"', async () => {
    installFakeBrowser();
    const services = new BackgroundServices();
    const route = createMessageRouter(services);
    const master = {
      ...media(`${PAGE}/master.m3u8`),
      protocol: 'hls' as const,
      variants: [
        {
          id: 'v1080',
          url: `${PAGE}/1080.m3u8`,
          kind: 'video' as const,
          protocol: 'hls' as const,
          format: 'ts' as const,
          tracks: { video: true, audio: true },
        },
      ],
    };
    await services.tabs.saveScan(1, {
      tabId: 1,
      pageUrl: PAGE,
      pageTitle: 'x',
      scannedAt: 0,
      candidates: [master],
      rejected: [],
      stats: {} as never,
    });
    const reply = await route(
      { type: 'START_DOWNLOAD', tabId: 1, candidateId: master.id, variantId: 'v480-gone' },
      extensionPage,
    );
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('no longer offered') });
  });

  it('answers the popup', async () => {
    installFakeBrowser();
    const route = createMessageRouter(new BackgroundServices());
    await expect(route({ type: 'GET_DOWNLOADS' }, extensionPage)).resolves.toEqual({
      type: 'DOWNLOADS_STATE',
      tasks: [],
    });
  });
});

describe('network observer', () => {
  function observe() {
    const api = installFakeBrowser();
    let handler: ((details: WebRequestDetails) => void) | undefined;
    api.webRequest.onResponseStarted = (_filter, listener) => {
      handler = listener;
      return () => undefined;
    };
    const network = new NetworkObserver();
    network.start(['https://site.example/*']);
    const send = (
      url: string,
      type: string,
      contentType?: string,
      extra: { frameId?: number; statusCode?: number; disposition?: string } = {},
    ) =>
      handler?.({
        url,
        tabId: 1,
        frameId: extra.frameId ?? 0,
        method: 'GET',
        type,
        statusCode: extra.statusCode ?? 200,
        timeStamp: Date.now(),
        responseHeaders: [
          ...(contentType ? [{ name: 'content-type', value: contentType }] : []),
          ...(extra.disposition ? [{ name: 'Content-Disposition', value: extra.disposition }] : []),
        ],
      });
    const sendRaw = (details: {
      url: string;
      type: string;
      frameId: number;
      documentLifecycle?: string;
      contentType?: string;
    }) =>
      handler?.({
        url: details.url,
        tabId: 1,
        frameId: details.frameId,
        method: 'GET',
        type: details.type,
        statusCode: 200,
        timeStamp: Date.now(),
        ...(details.documentLifecycle ? { documentLifecycle: details.documentLifecycle } : {}),
        responseHeaders: [{ name: 'content-type', value: details.contentType ?? 'text/html' }],
      });
    return { network, send, sendRaw };
  }

  it('re-verify: a link to a file the browser cannot show is a download, not a page', () => {
    const { network, send } = observe();
    send('https://site.example/watch/1', 'main_frame', 'text/html');
    send('https://site.example/a.m3u8', 'xmlhttprequest', 'application/vnd.apple.mpegurl');
    send('https://site.example/files/pack.zip', 'main_frame', 'application/zip');
    expect(network.candidatesFor(1).map((c) => c.url)).toEqual(['https://site.example/a.m3u8']);
  });

  it("re-verify: a prerendered page's media stays off the page on screen until it is shown", () => {
    const { network, sendRaw } = observe();
    sendRaw({ url: 'https://site.example/watch/1', type: 'main_frame', frameId: 0 });
    sendRaw({
      url: 'https://site.example/watch/2',
      type: 'main_frame',
      frameId: 42,
      documentLifecycle: 'prerender',
    });
    sendRaw({
      url: 'https://site.example/b.m3u8',
      type: 'xmlhttprequest',
      frameId: 42,
      documentLifecycle: 'prerender',
      contentType: 'application/vnd.apple.mpegurl',
    });
    expect(network.candidatesFor(1)).toEqual([]);

    // The user clicks through; the prerendered page is shown and reports.
    network.topFrameReported(1, {
      pageUrl: 'https://site.example/watch/2',
      pageTitle: 'Two',
      navigated: true,
      routeStartedAt: Date.now(),
    });
    expect(network.candidatesFor(1).map((c) => c.url)).toEqual(['https://site.example/b.m3u8']);
  });

  it('re-review: keeps the page media when a top-level response never becomes a page', () => {
    const { network, send } = observe();
    send('https://site.example/watch/1', 'main_frame', 'text/html');
    send('https://site.example/a.m3u8', 'xmlhttprequest', 'application/vnd.apple.mpegurl');

    // A link that downloads a file, a 204, and a prerendered page (frame id not 0).
    send('https://site.example/report.pdf', 'main_frame', 'application/pdf', {
      disposition: 'attachment; filename="report.pdf"',
    });
    send('https://site.example/ping', 'main_frame', undefined, { statusCode: 204 });
    send('https://site.example/watch/2', 'main_frame', 'text/html', { frameId: 7 });

    expect(network.candidatesFor(1).map((c) => c.url)).toEqual(['https://site.example/a.m3u8']);
  });

  it('starts a new page at the document request, forgetting the previous page', () => {
    const { network, send } = observe();
    send('https://site.example/old.m3u8', 'xmlhttprequest', 'application/vnd.apple.mpegurl');
    send('https://site.example/watch/2', 'main_frame', 'text/html');
    send('https://site.example/new.m3u8', 'xmlhttprequest', 'application/vnd.apple.mpegurl');

    expect(network.candidatesFor(1).map((c) => c.url)).toEqual(['https://site.example/new.m3u8']);

    // The page's own report arrives later. It must not reset again and lose the
    // manifest the page fetched before reporting.
    network.topFrameReported(1, {
      pageUrl: 'https://site.example/watch/2#t=10',
      pageTitle: 'Two',
      navigated: true,
      routeStartedAt: Date.now() - 2_000,
    });
    expect(network.candidatesFor(1)).toHaveLength(1);
  });

  it('pass 2 regression: a route change keeps what the new route fetched before its report', () => {
    vi.useFakeTimers({ now: 5_000_000 });
    try {
      const { network, send } = observe();
      send('https://site.example/watch/2', 'main_frame', 'text/html');
      send('https://site.example/old.m3u8', 'xmlhttprequest', 'application/vnd.apple.mpegurl');
      vi.setSystemTime(5_010_000); // pushState to /watch/3
      const routeStartedAt = Date.now();
      vi.setSystemTime(5_010_300); // its player fetches the new manifest...
      send('https://site.example/new.m3u8', 'xmlhttprequest', 'application/vnd.apple.mpegurl');
      vi.setSystemTime(5_011_000); // ...and only then does the page report
      network.topFrameReported(1, {
        pageUrl: 'https://site.example/watch/3',
        pageTitle: 'Three',
        navigated: true,
        routeStartedAt,
      });
      expect(network.candidatesFor(1).map((c) => c.url)).toEqual(['https://site.example/new.m3u8']);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-audit regression: a manifest's own size is not the video's size", () => {
    const { network, send } = observe();
    send('https://site.example/watch/1', 'main_frame', 'text/html');
    send('https://site.example/a.m3u8', 'xmlhttprequest', 'application/vnd.apple.mpegurl');
    expect(network.candidatesFor(1)[0]?.sizeBytes).toBeUndefined();
  });

  it('pass 2 regression: a ranged response reports the whole file size, not the range', () => {
    const { network } = observe();
    const api = installFakeBrowser();
    let handler: ((details: WebRequestDetails) => void) | undefined;
    api.webRequest.onResponseStarted = (_filter, listener) => {
      handler = listener;
      return () => undefined;
    };
    network.start(['https://site.example/*']);
    handler?.({
      url: 'https://site.example/film.mp4',
      tabId: 1,
      frameId: 0,
      method: 'GET',
      type: 'media',
      statusCode: 206,
      timeStamp: Date.now(),
      responseHeaders: [
        { name: 'content-type', value: 'video/mp4' },
        { name: 'content-length', value: '1024' },
        { name: 'content-range', value: 'bytes 0-1023/734003200' },
      ],
    });
    expect(network.candidatesFor(1)[0]?.sizeBytes).toBe(734_003_200);
  });
});

describe('manifest fetch classification', () => {
  it('treats the caller aborting as a cancellation, never a retryable failure', async () => {
    const controller = new AbortController();
    const fetching = fetchManifestText('https://cdn.example/a.m3u8', {
      timeoutMs: 5_000,
      signal: controller.signal,
      fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        })) as typeof fetch,
    });
    controller.abort();
    await expect(fetching).rejects.toMatchObject({ code: ErrorCode.CANCELLED });
  });

  it('classifies HTTP statuses like segment failures', async () => {
    const status = (code: number) =>
      (async () => new Response(null, { status: code })) as typeof fetch;
    await expect(
      fetchManifestText('https://cdn.example/a.m3u8', { timeoutMs: 1000, fetchImpl: status(404) }),
    ).rejects.toMatchObject({ code: ErrorCode.MEDIA_NOT_FOUND });
    await expect(
      fetchManifestText('https://cdn.example/a.m3u8', { timeoutMs: 1000, fetchImpl: status(403) }),
    ).rejects.toMatchObject({ code: ErrorCode.STREAM_EXPIRED });
  });

  it('re-audit (D18): a refusal names the host that answered, after any redirect', async () => {
    const redirected = (async () => {
      const response = new Response(null, { status: 403 });
      Object.defineProperty(response, 'url', { value: 'https://edge.other-cdn.example/a.m3u8' });
      return response;
    }) as typeof fetch;
    await expect(
      fetchManifestText('https://cdn.example/a.m3u8', { timeoutMs: 1000, fetchImpl: redirected }),
    ).rejects.toMatchObject({ code: ErrorCode.STREAM_EXPIRED, host: 'edge.other-cdn.example' });
  });

  it('reports a timeout as a network error', async () => {
    vi.useFakeTimers();
    try {
      const fetching = fetchManifestText('https://cdn.example/a.m3u8', {
        timeoutMs: 50,
        fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          })) as typeof fetch,
      });
      const assertion = expect(fetching).rejects.toMatchObject({
        code: ErrorCode.NETWORK_ERROR,
        message: expect.stringContaining('timed out'),
      });
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('segment fetching stops at the first hole', () => {
  it('regression: does not keep downloading once the file is doomed', async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('seg-1.ts')) return new Response(null, { status: 404 });
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as typeof fetch;

    const result = await fetchSegments({
      plan: {
        segments: Array.from({ length: 40 }, (_unused, i) => ({
          url: `https://cdn.example/seg-${i}.ts`,
        })),
        totalDuration: 160,
        live: false,
      },
      concurrency: 1,
      retries: 0,
      signal: new AbortController().signal,
      fetchImpl,
    });

    expect(result.failed).toEqual([1]);
    expect(result.firstError?.code).toBe(ErrorCode.MEDIA_NOT_FOUND);
    expect(requested.length).toBeLessThan(10);
  });
});

describe('re-audit: best download never acts on a page the tab has left', () => {
  it('regression: the shortcut on a page MediaGrab cannot read downloads nothing', async () => {
    const api = installFakeBrowser();
    api.tabs.get = async () => ({ id: 1, url: 'https://unrelated.example/', title: 'Other' });
    const services = new BackgroundServices();
    await services.tabs.saveScan(1, {
      tabId: 1,
      pageUrl: PAGE,
      pageTitle: 'x',
      scannedAt: 0,
      candidates: [media(`${PAGE}/a.mp4`)],
      rejected: [],
      stats: {} as never,
    });
    const enqueue = vi.fn();
    services.downloads = async () => ({ enqueue }) as never;

    await services.downloadBest(1);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
