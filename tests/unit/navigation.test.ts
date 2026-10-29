/**
 * D17: route changes in single-page apps - History API, hash routes and the
 * Navigation API - and a content script that arrives late.
 *
 * Three layers:
 *  1. The rules themselves (inject/routes.ts), pure.
 *  2. The real page hook (inject/page-hook.ts), loaded into a fake frame whose
 *     History API and Navigation API fire their events in the order the HTML
 *     standard gives them (Chromium follows it). This is unit-tested against
 *     the documented behaviour; tests/extension/navigation.spec.ts runs the
 *     same cases in a real Chromium.
 *  3. The real content script (content/index.ts), loaded into a fake document
 *     with a controllable clock and Resource Timing list, reporting to a fake
 *     worker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApi } from '../../src/browser/api.ts';
import { envelope, type HookMessage, parseHookMessage } from '../../src/core/hook-protocol.ts';
import type { PageReport } from '../../src/core/messages.ts';
import {
  hasShownOneRoute,
  isRouteHash,
  routeOf,
  type SessionEntry,
} from '../../src/inject/routes.ts';
import { withoutFragment } from '../../src/media/fingerprint.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';

const APP = 'https://app.example';

// ─── 1. The rules ────────────────────────────────────────────────────────────

describe('D17: which fragments are routes', () => {
  it.each([
    '#/',
    '#/video/2',
    '#/a?b=c',
    '#!',
    '#!/video/2',
    '#!video',
    '/video/2', // without the '#', as a fragment on its own
  ])('D17: %s names a route', (hash) => {
    expect(isRouteHash(hash)).toBe(true);
  });

  it.each([
    '',
    '#',
    '#top',
    '#comments',
    '#section-2',
    '#t=90',
    '#t=10,20',
    'top',
    // Backbone-style bare paths are deliberately not recognised: from the
    // fragment alone they look like any element id.
    '#video/2',
  ])('D17: %j is an in-page anchor, not a route', (hash) => {
    expect(isRouteHash(hash)).toBe(false);
  });
});

describe('D17: the route an address is on', () => {
  it('D17: a path, a query or a route fragment is part of the route', () => {
    expect(routeOf(`${APP}/watch/1`)).toBe(`${APP}/watch/1`);
    expect(routeOf(`${APP}/#/video/2`)).toBe(`${APP}/#/video/2`);
    expect(routeOf(`${APP}/#!/video/2`)).toBe(`${APP}/#!/video/2`);
    expect(routeOf(`${APP}/#/a?b=c`)).not.toBe(routeOf(`${APP}/#/a?b=d`));
    expect(routeOf(`${APP}/#/video/1`)).not.toBe(routeOf(`${APP}/#/video/2`));
  });

  it('D17: an anchor is not part of the route', () => {
    expect(routeOf(`${APP}/watch/1#comments`)).toBe(`${APP}/watch/1`);
    expect(routeOf(`${APP}/watch/1#t=90`, `${APP}/watch/1`)).toBe(`${APP}/watch/1`);
    expect(routeOf(`${APP}/watch/1#`, `${APP}/watch/1`)).toBe(`${APP}/watch/1`);
  });

  it('D17: an anchor inside a hash-routed page keeps the route the page is on', () => {
    const video = `${APP}/#/video/2`;
    expect(routeOf(`${APP}/#comments`, video)).toBe(video);
    expect(routeOf(`${APP}/#t=90`, video)).toBe(video);
  });

  it('D17: an anchor on another path is that path', () => {
    expect(routeOf(`${APP}/watch/3#comments`, `${APP}/#/video/2`)).toBe(`${APP}/watch/3`);
  });

  it('D17: a placeholder `#!` or `#/` link on a page with no hash route is an anchor, not a new route', () => {
    // `<a href="#!">` is how many sites write a link a click handler serves.
    const watch = `${APP}/watch/1`;
    for (const hash of ['#!', '#/', '#!/']) {
      expect(routeOf(`${watch}${hash}`, watch)).toBe(watch);
    }
    // From a hash route the same fragments are a real move to the app's root.
    expect(routeOf(`${APP}/#/`, `${APP}/#/video/2`)).toBe(`${APP}/#/`);
    expect(routeOf(`${APP}/#!`, `${APP}/#!/video/2`)).toBe(`${APP}/#!`);
    // A late content script still vouches for the one route on screen.
    const entries = [watch, `${watch}#!`].map((url) => ({ url, sameDocument: true }));
    expect(hasShownOneRoute(entries, 2)).toBe(true);
  });
});

describe('D17: has this document shown one route all its life?', () => {
  const entry = (path: string, sameDocument = true): SessionEntry => ({
    url: `${APP}${path}`,
    sameDocument,
  });

  it('D17: one same-document entry, whatever other pages the tab visited', () => {
    expect(hasShownOneRoute([entry('/search', false), entry('/watch/1')], 7)).toBe(true);
  });

  it('D17: anchors and replaced addresses leave it on one route', () => {
    expect(hasShownOneRoute([entry('/watch/1'), entry('/watch/1#comments')], 2)).toBe(true);
    expect(hasShownOneRoute([entry('/#/video/2'), entry('/#t=90'), entry('/#comments')], 3)).toBe(
      true,
    );
  });

  it('D17: another path, query or hash route of this document is another route', () => {
    expect(hasShownOneRoute([entry('/'), entry('/watch/2')], 2)).toBe(false);
    expect(hasShownOneRoute([entry('/watch?v=1'), entry('/watch?v=2')], 2)).toBe(false);
    expect(hasShownOneRoute([entry('/#/video/1'), entry('/#/video/2')], 2)).toBe(false);
    expect(hasShownOneRoute([entry('/#comments'), entry('/#/video/2')], 2)).toBe(false);
  });

  it('D17: entries after the current one count - the user came back from them', () => {
    // The current entry is the first; /watch/2 is "forward". Its requests
    // are in this document's Resource Timing all the same.
    expect(hasShownOneRoute([entry('/watch/1'), entry('/watch/2')], 2)).toBe(false);
  });

  it('D17: an entry with no URL vouches for nothing', () => {
    expect(hasShownOneRoute([entry('/watch/1'), { url: null, sameDocument: true }], 2)).toBe(false);
  });

  it('D17: without the Navigation API only a single-entry tab can vouch', () => {
    expect(hasShownOneRoute(undefined, 1)).toBe(true);
    expect(hasShownOneRoute(undefined, 2)).toBe(false);
    expect(hasShownOneRoute([], 1)).toBe(true);
    expect(hasShownOneRoute([], 4)).toBe(false);
  });
});

describe('D17: the hook protocol carries when a route began', () => {
  const on = (message: Record<string, unknown>) => ({ channel: 'mediagrab:page-hook', ...message });

  it('D17: navigate keeps a usable stamp and drops anything else', () => {
    expect(parseHookMessage(on({ kind: 'navigate', at: 1234.5 }))).toEqual({
      kind: 'navigate',
      at: 1234.5,
    });
    for (const at of [-1, Number.NaN, Number.POSITIVE_INFINITY, '12', null]) {
      expect(parseHookMessage(on({ kind: 'navigate', at }))).toEqual({ kind: 'navigate' });
    }
  });
});

// ─── 2. The page hook in a fake frame ────────────────────────────────────────

type NavigationType = 'push' | 'replace' | 'traverse';

/** Real `performance`, except the parts a test needs to control. */
function fakePerformance(
  now: () => number,
  timeOrigin: number,
  resources: () => readonly PerformanceEntry[] = () => [],
): Performance {
  const real = globalThis.performance;
  const own: Record<PropertyKey, unknown> = {
    now,
    timeOrigin,
    getEntriesByType: (type: string) => (type === 'resource' ? [...resources()] : []),
  };
  return new Proxy(real, {
    get(target, key) {
      if (key in own) return own[key];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

class FakeWindow extends EventTarget {
  readonly posted: HookMessage[] = [];
  navigation?: unknown;

  postMessage(data: unknown): void {
    const message = parseHookMessage(data);
    if (message) this.posted.push(message);
  }
}

/**
 * One frame as the hook sees it: a document, its address, its session history
 * and, unless `navigationApi` is false, Chromium's Navigation API. Events fire
 * in the HTML standard's order:
 *
 *   pushState / replaceState   navigate, [address changes], currententrychange,
 *                              later navigatesuccess
 *   fragment navigation        navigate, [address], currententrychange, popstate,
 *                              then a task later hashchange; later navigatesuccess
 *   back                       navigate, [address], currententrychange, popstate,
 *                              hashchange if the fragment differs; navigatesuccess
 *   navigation.navigate()      navigate (the router intercepts it), [address],
 *     intercepted              currententrychange, the router's handler runs,
 *                              navigatesuccess when it settles
 */
function createFrame(start: string, { navigationApi = true } = {}) {
  const win = new FakeWindow();
  const location = { href: start };
  const entries = [start];
  let index = 0;
  let perf = 1_000;
  const navigation = navigationApi ? new EventTarget() : undefined;
  if (navigation) win.navigation = navigation;
  const pageCalls: unknown[][] = [];

  const fire = (target: EventTarget | undefined, type: string, fields: object = {}) =>
    target?.dispatchEvent(Object.assign(new Event(type), fields));
  const succeedLater = () => queueMicrotask(() => fire(navigation, 'navigatesuccess'));
  const announce = (type: NavigationType, url: string, hashChange: boolean) =>
    fire(navigation, 'navigate', { navigationType: type, destination: { url }, hashChange });

  /** The standard's "URL and history update steps". */
  function commit(url: string, type: NavigationType) {
    if (type === 'push') {
      entries.splice(index + 1, entries.length, url);
      index += 1;
    } else if (type === 'replace') {
      entries[index] = url;
    }
    location.href = url;
    fire(navigation, 'currententrychange', { navigationType: type });
  }

  const historyMove = (type: 'push' | 'replace') =>
    function (this: unknown, ...args: unknown[]) {
      pageCalls.push(args);
      const url = new URL(String(args[2]), location.href).href;
      announce(type, url, false);
      commit(url, type);
      succeedLater();
      return undefined;
    };

  const history = {
    get length() {
      return entries.length;
    },
    pushState: historyMove('push'),
    replaceState: historyMove('replace'),
  };

  return {
    window: win,
    location,
    history,
    performance: fakePerformance(() => perf, 1_700_000_000_000),
    pageCalls,
    tick(ms: number) {
      perf += ms;
    },
    get perf() {
      return perf;
    },
    navigates: () => win.posted.filter((message) => message.kind === 'navigate'),

    /** `location.hash = hash` or an `<a href="#...">` click; `replace` is `location.replace()`. */
    setHash(hash: string, type: 'push' | 'replace' = 'push') {
      const url = withoutFragment(location.href) + hash;
      announce(type, url, true);
      commit(url, type);
      fire(win, 'popstate');
      setTimeout(() => fire(win, 'hashchange'), 0);
      succeedLater();
    },

    back() {
      const from = location.href;
      const to = entries[index - 1];
      if (to === undefined) throw new Error('nothing to go back to');
      announce('traverse', to, false);
      index -= 1;
      commit(to, 'traverse');
      fire(win, 'popstate');
      if (from.split('#')[1] !== to.split('#')[1]) setTimeout(() => fire(win, 'hashchange'), 0);
      succeedLater();
    },

    /** `navigation.navigate(url)`, intercepted by the page's router, whose handler loads the route. */
    async navigate(url: string, type: 'push' | 'replace', handler: () => Promise<void>) {
      const target = new URL(url, location.href).href;
      announce(type, target, false);
      commit(target, type);
      await handler();
      fire(navigation, 'navigatesuccess');
    },
  };
}

type Frame = ReturnType<typeof createFrame>;

/** Tasks queued by the frame (hashchange) and the microtasks before them. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const realCreateObjectURL = URL.createObjectURL;

async function loadHook(frame: Frame): Promise<void> {
  vi.stubGlobal('window', frame.window);
  vi.stubGlobal('location', frame.location);
  vi.stubGlobal('history', frame.history);
  vi.stubGlobal('document', { baseURI: frame.location.href });
  vi.stubGlobal('performance', frame.performance);
  vi.resetModules();
  await import('../../src/inject/page-hook.ts');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // The hook wraps the global URL.createObjectURL, which is Node's own here.
  URL.createObjectURL = realCreateObjectURL;
});

describe.each([
  { api: 'with the Navigation API', navigationApi: true },
  { api: 'without the Navigation API', navigationApi: false },
])('D17: the page hook, $api', ({ navigationApi }) => {
  it('D17: a new hash route is a new route, posted once', async () => {
    const frame = createFrame(`${APP}/#/video/1`, { navigationApi });
    await loadHook(frame);
    frame.setHash('#/video/2');
    await settle();
    expect(frame.navigates()).toHaveLength(1);
    frame.setHash('#!/video/3');
    await settle();
    expect(frame.navigates()).toHaveLength(2);
  });

  it('D17: `#/` and `#!` on their own are the root route', async () => {
    const frame = createFrame(`${APP}/#/video/2`, { navigationApi });
    await loadHook(frame);
    frame.setHash('#/');
    await settle();
    frame.setHash('#!');
    await settle();
    expect(frame.navigates()).toHaveLength(2);
  });

  it('D17: placeholder links (`#!`, `#/`) on a page with no hash route are not a new route', async () => {
    const frame = createFrame(`${APP}/watch/1`, { navigationApi });
    await loadHook(frame);
    for (const hash of ['#!', '#/', '#comments', '#!/', '#!']) {
      frame.setHash(hash);
      await settle();
    }
    expect(frame.navigates()).toHaveLength(0);
  });

  it('D17: in-page anchors are not a new route, on a plain page or a hash-routed one', async () => {
    const frame = createFrame(`${APP}/watch/1`, { navigationApi });
    await loadHook(frame);
    for (const hash of ['#comments', '#t=90', '#top', '#']) {
      frame.setHash(hash);
      await settle();
    }
    expect(frame.navigates()).toHaveLength(0);

    frame.setHash('#/video/2');
    await settle();
    expect(frame.navigates()).toHaveLength(1);
    // A jump inside video 2, and back to it: still video 2.
    frame.setHash('#comments');
    await settle();
    frame.back();
    await settle();
    expect(frame.navigates()).toHaveLength(1);
  });

  it('D17: back and forward across routes is a new route each way, posted once each', async () => {
    const frame = createFrame(`${APP}/watch/1`, { navigationApi });
    await loadHook(frame);
    frame.history.pushState({}, '', '/watch/2');
    await settle();
    frame.back();
    await settle();
    expect(frame.navigates()).toHaveLength(2);
  });

  it('D17: replaceState tidies the address; a later push to that address is no route change', async () => {
    const frame = createFrame(`${APP}/watch/1?utm_source=mail`, { navigationApi });
    await loadHook(frame);
    frame.history.replaceState({}, '', '/watch/1');
    await settle();
    frame.history.pushState({}, '', '/watch/1');
    await settle();
    expect(frame.navigates()).toHaveLength(0);
    frame.history.pushState({}, '', '/watch/2');
    await settle();
    expect(frame.navigates()).toHaveLength(1);
  });

  it('D17: the route change is stamped with the moment the address changed', async () => {
    const frame = createFrame(`${APP}/watch/1`, { navigationApi });
    await loadHook(frame);
    frame.tick(4_000);
    frame.history.pushState({}, '', '/watch/2');
    const at = frame.perf;
    frame.tick(300); // the message is read later; the stamp is not
    await settle();
    expect(frame.navigates()).toEqual([{ kind: 'navigate', at }]);
  });
});

describe('D17: the page hook follows the Navigation API', () => {
  it('D17: navigation.navigate() that a router intercepts starts a new route once, when the address commits', async () => {
    const frame = createFrame(`${APP}/app`);
    await loadHook(frame);
    frame.tick(1_000);
    const committedAt = frame.perf;
    await frame.navigate('/app/video/2', 'push', async () => {
      // The router loads the route: the player fetches, time passes, and
      // only then does the navigation succeed.
      frame.tick(800);
    });
    await settle();
    expect(frame.navigates()).toEqual([{ kind: 'navigate', at: committedAt }]);
  });

  it('D17: a pushState that the Navigation API also reports is one route change, not three', async () => {
    const frame = createFrame(`${APP}/watch/1`);
    await loadHook(frame);
    frame.history.pushState({}, '', '/watch/2');
    await settle();
    expect(frame.navigates()).toHaveLength(1);
  });

  it('D17: a navigation that replaces its entry is not a new route', async () => {
    const frame = createFrame(`${APP}/app`);
    await loadHook(frame);
    await frame.navigate('/app/home', 'replace', async () => undefined);
    await settle();
    expect(frame.navigates()).toHaveLength(0);
    // ...and the address it left the page at is that same route.
    frame.history.pushState({}, '', '/app/home');
    await settle();
    expect(frame.navigates()).toHaveLength(0);
  });

  it('D17: a hash location.replace() is a tidy where the Navigation API can say so, a move where nothing can', async () => {
    const withApi = createFrame(`${APP}/#/`);
    await loadHook(withApi);
    withApi.setHash('#/home', 'replace');
    await settle();
    expect(withApi.navigates()).toHaveLength(0);

    vi.unstubAllGlobals();
    const withoutApi = createFrame(`${APP}/#/`, { navigationApi: false });
    await loadHook(withoutApi);
    withoutApi.setHash('#/home', 'replace');
    await settle();
    expect(withoutApi.navigates()).toHaveLength(1);
  });

  it('regression: a broken Navigation API neither stops the History API hooks nor changes what pushState does', async () => {
    const frame = createFrame(`${APP}/watch/1`, { navigationApi: false });
    frame.window.navigation = {
      addEventListener() {
        throw new Error('not today');
      },
    };
    await loadHook(frame);
    const state = { id: 2 };
    const result = frame.history.pushState(state, '', '/watch/2');
    expect(result).toBeUndefined();
    expect(frame.pageCalls).toEqual([[state, '', '/watch/2']]);
    expect(frame.location.href).toBe(`${APP}/watch/2`);
    expect(frame.navigates()).toHaveLength(1);
  });
});

// ─── 3. The content script in a fake document ────────────────────────────────

const TIME_ORIGIN = 1_700_000_000_000;
const PAGE = `${APP}/watch/2`;
const OLD_ROUTE = 'https://cdn.example/route-one/master.m3u8';
const NEW_ROUTE = 'https://cdn.example/route-two/master.m3u8';

interface ContentPage {
  /** Documents already in Resource Timing (startTime on the document's clock). */
  resources?: Array<{ name: string; startTime: number }>;
  readyState?: DocumentReadyState;
  /** navigation.entries(); undefined = no Navigation API. */
  entries?: SessionEntry[] | (() => SessionEntry[]);
  historyLength?: number;
  /** The document's clock when the script starts. */
  loadedAt?: number;
}

/**
 * Load the real content script into a fake document. Clocks: `Date` is faked
 * by Vitest, and `performance.now()` is Date.now() minus the time origin, so
 * both move together with `vi.advanceTimersByTime`.
 */
async function loadContentScript(page: ContentPage = {}) {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(TIME_ORIGIN + (page.loadedAt ?? 5));

  const resources = (page.resources ?? []).map(
    (entry) => ({ entryType: 'resource', ...entry }) as unknown as PerformanceEntry,
  );
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const on = (type: string, listener: (event: unknown) => void) =>
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  const emit = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };

  const win = {
    addEventListener: on,
    postMessage: () => undefined,
    ...(page.entries
      ? {
          navigation: {
            addEventListener: () => undefined,
            entries: typeof page.entries === 'function' ? page.entries : () => page.entries,
          },
        }
      : {}),
  };
  const location = { href: PAGE, origin: APP };
  const document = {
    readyState: page.readyState ?? 'loading',
    title: 'Video two | App',
    baseURI: PAGE,
    documentElement: {},
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: on,
  };
  let observed: ((list: { getEntries(): PerformanceEntry[] }) => void) | undefined;

  vi.stubGlobal('window', win);
  vi.stubGlobal('location', location);
  vi.stubGlobal('document', document);
  vi.stubGlobal('history', { length: page.historyLength ?? 1 });
  vi.stubGlobal(
    'performance',
    fakePerformance(
      () => Date.now() - TIME_ORIGIN,
      TIME_ORIGIN,
      () => resources,
    ),
  );
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
    },
  );
  vi.stubGlobal(
    'PerformanceObserver',
    class {
      constructor(callback: typeof observed) {
        observed = callback;
      }
      observe(options: { buffered?: boolean }) {
        // The browser hands a buffered observer the entries so far, a moment later.
        if (options.buffered)
          queueMicrotask(() => observed?.({ getEntries: () => [...resources] }));
      }
    },
  );
  delete (globalThis as Record<string, unknown>).__mediaGrabContentLoaded;

  vi.resetModules();
  const sent: PageReport[] = [];
  const fake: BrowserApi = createFakeBrowserApi();
  fake.runtime.sendMessage = async (message: unknown) => {
    const { type, ...report } = message as { type: string } & PageReport;
    if (type === 'PAGE_REPORT') sent.push(report);
    return undefined;
  };
  const { __setBrowserApi } = await import('../../src/browser/index.ts');
  __setBrowserApi(fake);
  await import('../../src/content/index.ts');
  await Promise.resolve(); // buffered Resource Timing arrives

  return {
    /** The document finished parsing. */
    parsed() {
      emit('DOMContentLoaded', {});
    },
    /** A new Resource Timing entry, delivered to the observer. */
    fetched(name: string, startTime: number) {
      const entry = { entryType: 'resource', name, startTime } as unknown as PerformanceEntry;
      resources.push(entry);
      observed?.({ getEntries: () => [entry] });
    },
    /** A message from the page hook. */
    hook(message: HookMessage) {
      emit('message', { source: win, origin: APP, data: envelope(message) });
    },
    pageshow(persisted: boolean) {
      emit('pageshow', { persisted });
    },
    /** Let every pending report go out, and return the last one. */
    latest(): PageReport {
      vi.advanceTimersByTime(3_000);
      const report = sent.at(-1);
      if (!report) throw new Error('no report was sent');
      return report;
    },
    now: () => Date.now() - TIME_ORIGIN,
  };
}

const urls = (report: PageReport) => report.candidates.map((claim) => claim.url);

describe('D17: the content script starts a route where the page says it began', () => {
  async function onRouteOne() {
    const page = await loadContentScript({ loadedAt: 5 });
    page.parsed();
    page.fetched(OLD_ROUTE, 200);
    expect(urls(page.latest())).toEqual([OLD_ROUTE]);
    return page;
  }

  it("D17: requests the new route made before the message arrived are kept, the old route's are not", async () => {
    const page = await onRouteOne();
    vi.setSystemTime(TIME_ORIGIN + 4_000);
    // The router moved at 4000 and its player fetched in the same task; the
    // browser delivered that entry before the hook's message was read.
    page.fetched(NEW_ROUTE, 4_020);
    vi.setSystemTime(TIME_ORIGIN + 4_300);
    page.hook({ kind: 'navigate', at: 4_000 });

    const report = page.latest();
    expect(urls(report)).toEqual([NEW_ROUTE]);
    expect(report.routeStartedAt).toBe(TIME_ORIGIN + 4_000);
  });

  it('D17: a stamp from before the route that is ending, or from the future, is not believed', async () => {
    const page = await onRouteOne();
    vi.setSystemTime(TIME_ORIGIN + 4_000);
    page.fetched(NEW_ROUTE, 4_020);
    page.hook({ kind: 'navigate', at: 4_000 });
    const second = page.latest();

    // A page claiming its route began at 0 cannot bring route one back.
    vi.setSystemTime(TIME_ORIGIN + 9_000);
    page.hook({ kind: 'navigate', at: 0 });
    const third = page.latest();
    expect(urls(third)).not.toContain(OLD_ROUTE);
    expect(third.routeStartedAt).toBeGreaterThan(second.routeStartedAt);

    page.hook({ kind: 'navigate', at: 10 ** 12 });
    const fourth = page.latest();
    expect(fourth.routeStartedAt).toBeGreaterThan(third.routeStartedAt);
    expect(fourth.routeStartedAt).toBeLessThanOrEqual(Date.now());
  });

  it('D17: a navigate without a stamp starts the route when it is read', async () => {
    const page = await onRouteOne();
    vi.setSystemTime(TIME_ORIGIN + 6_000);
    page.hook({ kind: 'navigate' });
    expect(page.latest().routeStartedAt).toBe(TIME_ORIGIN + 6_000);
  });

  it('regression: a back-forward-cache restore is a new route that keeps what the page fetched', async () => {
    const page = await onRouteOne();
    const before = page.latest().routeStartedAt;
    vi.setSystemTime(TIME_ORIGIN + 30_000);
    page.pageshow(true);
    const report = page.latest();
    expect(report.routeStartedAt).toBeGreaterThan(before);
    expect(urls(report)).toEqual([OLD_ROUTE]);
  });
});

describe('D17: a content script injected late', () => {
  const at = (path: string, sameDocument = true): SessionEntry => ({
    url: `${APP}${path}`,
    sameDocument,
  });
  const earlier = [
    { name: OLD_ROUTE, startTime: 1_000 },
    { name: NEW_ROUTE, startTime: 30_000 },
  ];

  it('D17: into a page that has shown one route, keeps everything the page fetched', async () => {
    const page = await loadContentScript({
      readyState: 'complete',
      loadedAt: 60_000,
      resources: earlier,
      entries: [at('/search', false), at('/watch/2'), at('/watch/2#comments')],
      historyLength: 3,
    });
    const report = page.latest();
    expect(urls(report).sort()).toEqual([NEW_ROUTE, OLD_ROUTE].sort());
    expect(report.routeStartedAt).toBe(TIME_ORIGIN);
  });

  it('D17: into a single-page app that has moved on, drops what earlier routes fetched and keeps what comes next', async () => {
    const page = await loadContentScript({
      readyState: 'complete',
      loadedAt: 60_000,
      resources: earlier,
      entries: [at('/'), at('/watch/1'), at('/watch/2')],
      historyLength: 3,
    });
    const report = page.latest();
    expect(urls(report)).toEqual([]);
    expect(report.routeStartedAt).toBe(TIME_ORIGIN + 60_000);

    page.fetched('https://cdn.example/route-two/audio.m3u8', 61_000);
    expect(urls(page.latest())).toEqual(['https://cdn.example/route-two/audio.m3u8']);
  });

  it('D17: into a hash-routed app that has moved between hash routes, drops the earlier requests', async () => {
    const page = await loadContentScript({
      readyState: 'interactive',
      loadedAt: 60_000,
      resources: earlier,
      entries: [at('/#/video/1'), at('/#/video/2')],
      historyLength: 2,
    });
    expect(urls(page.latest())).toEqual([]);
  });

  it('D17: without the Navigation API, only a tab with a single history entry vouches for its requests', async () => {
    const alone = await loadContentScript({
      readyState: 'complete',
      loadedAt: 60_000,
      resources: earlier,
      historyLength: 1,
    });
    expect(urls(alone.latest())).toHaveLength(2);

    const withHistory = await loadContentScript({
      readyState: 'complete',
      loadedAt: 60_000,
      resources: earlier,
      historyLength: 4,
    });
    expect(urls(withHistory.latest())).toEqual([]);
  });

  it('D17: a session history the page will not let us read falls back to the history length', async () => {
    const page = await loadContentScript({
      readyState: 'complete',
      loadedAt: 60_000,
      resources: earlier,
      entries: () => {
        throw new Error('no');
      },
      historyLength: 5,
    });
    expect(urls(page.latest())).toEqual([]);
  });

  it('D17: registered at document_start the script is on time, whatever the history says', async () => {
    const page = await loadContentScript({
      readyState: 'loading',
      loadedAt: 5,
      resources: [{ name: OLD_ROUTE, startTime: 2 }], // a preload the parser fetched first
      entries: [at('/'), at('/watch/2')],
      historyLength: 2,
    });
    page.parsed();
    const report = page.latest();
    expect(urls(report)).toEqual([OLD_ROUTE]);
    expect(report.routeStartedAt).toBe(TIME_ORIGIN);
  });
});
