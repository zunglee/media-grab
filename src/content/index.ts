/**
 * Content script (ISOLATED world). Runs in every frame of a granted site, next
 * to the page hook (MAIN world, inject/page-hook.ts) in the same document.
 *
 * What it does, in order of a page's life:
 *
 *   document_start   listen to the page hook (and ask it to replay what it saw)
 *                    and to Resource Timing - the page's own list of every URL
 *                    it fetched, CDN hosts included, which the network
 *                    observer cannot see without a grant for that host
 *   (or later)       injected right after a grant: decide whether what the
 *                    page fetched before belongs to the route on screen
 *   DOM parsed       scan the DOM, report, and rescan whenever it changes
 *   route change     History API, hash route or Navigation API (all seen by
 *                    the hook), or a back-forward-cache restore: forget the
 *                    old route, report at once
 *   "Scan again"     the worker asks; answer with a fresh report
 *
 * A report is always the whole picture of this frame, never a delta: what the
 * DOM shows now, every URL the page fetched on this route, and its signals.
 * That is what makes the flow forgiving: if a report is lost or overtaken,
 * the next one repairs it. DOM claims are re-read on every report (an element
 * that left the page is gone); fetched URLs accumulate, since a player fetches
 * its manifest once; and a <video> that played - its URL was fetched on this
 * route - keeps its title and poster after the page removes it (a closed
 * lightbox).
 *
 * Trust boundary: everything read here comes from a page that may be hostile.
 * Nothing is evaluated, and what is sent is a list of claims the worker checks
 * and rebuilds (core/messages.ts, detection/candidate.ts).
 */
import { browserApi } from '../browser/index.ts';
import { envelope, parseHookMessage } from '../core/hook-protocol.ts';
import { MAX_CANDIDATES_PER_FRAME, MAX_TITLE_LENGTH } from '../core/limits.ts';
import { createLogger } from '../core/log.ts';
import type { ExtensionMessage, PageReport, ReportedCandidate } from '../core/messages.ts';
import { scanDom } from '../detection/dom.ts';
import { hasShownOneRoute, navigationApi, type SessionEntry } from '../inject/routes.ts';
import { classifyMediaUrl } from '../media/format.ts';

const log = createLogger('content');

/**
 * The script is both registered (for granted origins, at document_start) and
 * injected on demand right after a grant, so it can be asked to run twice in
 * one document. Running twice would double every listener; the second run
 * does nothing.
 */
const LOADED_FLAG = '__mediaGrabContentLoaded';
const alreadyLoaded = (globalThis as Record<string, unknown>)[LOADED_FLAG] === true;
(globalThis as Record<string, unknown>)[LOADED_FLAG] = true;

/** Coalesce DOM churn; players mutate the DOM continuously during playback. */
const REPORT_DEBOUNCE_MS = 700;
/** A second pass once late scripts have run. */
const LATE_PASS_MS = 2_500;

/**
 * What this frame has collected on the current route. A new document's route
 * starts at the document's own time origin, not when this script started: the
 * browser's preload scanner can fetch a `<link rel="preload">` manifest before
 * any document_start script runs, and that fetch belongs to this page. (A
 * script injected late may move the start to its own arrival: `startLateRoute`.)
 */
const route = {
  /** Epoch ms; see PageReport.routeStartedAt. */
  startedAt: Math.round(performance.timeOrigin),
  /** Same moment on this document's own clock (0 = its time origin), to compare with Resource Timing. */
  startedAtPerf: 0,
  hasMediaSource: false,
  hasMediaKeys: false,
  /** URLs the page fetched (hook, Resource Timing), keyed by kind + URL; oldest first. */
  fetched: new Map<string, ReportedCandidate>(),
  /** Media-element claims whose URL was also fetched on this route: what actually played. */
  played: new Map<string, ReportedCandidate>(),
};

const claimKey = (claim: ReportedCandidate) => `${claim.kind} ${claim.url}`;

/** Reports wait for the DOM, and for a prerendered page to be shown (see below). */
let started = false;
let reportTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The report made for the latest "Scan again". The worker asks this frame
 * twice per scan (once with every frame, once addressed to the top frame), with
 * one request id; both get the same report. Any other report is never reused,
 * because it may have been built before the request was made.
 */
let answered: { requestId: string; reply: Promise<unknown> } | null = null;

/** A URL the page fetched. Stream segments are dropped: one video fetches thousands. */
function rememberFetched(url: string, mimeType?: string): boolean {
  const media = classifyMediaUrl(url, mimeType);
  if (!media || media.isSegment || !/^https?:\/\//i.test(url)) return false;
  const key = claimKey({ url, kind: media.kind, source: 'page-hook' });
  if (!route.fetched.has(key) && route.fetched.size >= MAX_CANDIDATES_PER_FRAME) {
    const oldest = route.fetched.keys().next();
    if (!oldest.done) route.fetched.delete(oldest.value);
  }
  route.fetched.set(key, {
    url,
    kind: media.kind,
    source: 'page-hook',
    ...(mimeType ? { mimeType } : {}),
  });
  return true;
}

/**
 * The page on screen changed. `forget` drops the old route's claims (a new
 * route); a back-forward-cache restore keeps them, because they are this very
 * page's, and the player will not fetch them again.
 *
 * `at` is when the hook saw the address change, on this document's clock. The
 * route starts there, not now: a router fetches the new route's media in the
 * same task, and those requests are already in Resource Timing, which is read
 * again below. A stamp from before the route that is ending or from the future
 * is the page's invention, and is pulled back inside that range. Each route
 * gets a later `routeStartedAt` than the last: a new value is how the worker
 * tells a navigation (tab-store.ts `applyReport`).
 */
function newRoute(forget: boolean, at?: number): void {
  const now = performance.now();
  const start = at === undefined ? now : Math.min(Math.max(at, route.startedAtPerf), now);
  route.startedAt = Math.max(route.startedAt + 1, Date.now() - Math.round(now - start));
  route.startedAtPerf = start;
  if (forget) {
    route.fetched.clear();
    route.played.clear();
    route.hasMediaSource = false;
    route.hasMediaKeys = false;
    rememberResourceTiming(resourceTimingSoFar());
  }
  reportSoon(0);
  // Routers often change the URL before they render the new route; a second
  // look catches the new DOM even if no mutation we watch announces it.
  setTimeout(() => reportSoon(0), LATE_PASS_MS);
}

function buildReport(): PageReport {
  let dom: ReturnType<typeof scanDom> | undefined;
  try {
    dom = scanDom(document);
  } catch (err) {
    // Report what we already know rather than nothing.
    log.warn('DOM scan failed', err instanceof Error ? err.message : String(err));
  }
  return {
    pageUrl: location.href,
    pageTitle: document.title.slice(0, MAX_TITLE_LENGTH),
    routeStartedAt: route.startedAt,
    signals: {
      hasMediaSource: route.hasMediaSource || dom?.signals.hasMediaSource === true,
      hasMediaKeys: route.hasMediaKeys || dom?.signals.hasMediaKeys === true,
      mediaElements: dom?.signals.mediaElements ?? 0,
      playerFrames: dom?.signals.playerFrames ?? 0,
    },
    ...(dom?.pagePoster ? { pagePoster: dom.pagePoster } : {}),
    candidates: reportOrder(dom?.found ?? []),
  };
}

/**
 * The claims to send, most valuable first, since the per-frame cap and the
 * worker's size budget both cut from the end: media elements (they carry the
 * titles, posters and subtitles), then what the page fetched (the manifests),
 * then links and metadata, which a page can have thousands of. The worker
 * merges duplicates, so a URL listed twice costs nothing but space.
 */
function reportOrder(domClaims: ReportedCandidate[]): ReportedCandidate[] {
  for (const claim of domClaims) {
    const key = claimKey(claim);
    if (claim.source === 'dom-element' && route.fetched.has(key)) route.played.set(key, claim);
  }
  const onScreen = new Set(domClaims.map(claimKey));
  const elements = [
    ...domClaims.filter((claim) => claim.source === 'dom-element'),
    ...[...route.played.values()].filter((claim) => !onScreen.has(claimKey(claim))),
  ];
  const others = domClaims.filter((claim) => claim.source !== 'dom-element');
  return [...elements, ...route.fetched.values(), ...others].slice(0, MAX_CANDIDATES_PER_FRAME);
}

/** Resolves with the worker's reply once it has stored the report. */
function sendReport(): Promise<unknown> {
  const message: ExtensionMessage = { type: 'PAGE_REPORT', ...buildReport() };
  return browserApi().runtime.sendMessage(message);
}

function reportSoon(delayMs = REPORT_DEBOUNCE_MS): void {
  if (!started) return; // the first report goes out when the DOM is ready
  if (reportTimer) clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    reportTimer = null;
    void sendReport();
  }, delayMs);
}

/**
 * Messages from the MAIN world. `event.source === window` stops a nested frame
 * or another window posting to us; the origin check stops another origin's
 * document in this window ('null' is a sandboxed frame's own opaque origin).
 * The shape is checked by `parseHookMessage`, the URL again by the worker.
 */
function listenToPageHook(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.origin !== location.origin && event.origin !== 'null') return;
    const message = parseHookMessage(event.data);
    if (!message) return;

    switch (message.kind) {
      case 'url':
        if (rememberFetched(message.url, message.mimeType)) reportSoon();
        break;
      case 'mse':
        route.hasMediaSource = true;
        reportSoon();
        break;
      case 'keys':
        route.hasMediaKeys = true;
        reportSoon();
        break;
      case 'navigate':
        newRoute(true, message.at);
        break;
      case 'hello':
        break; // our own greeting, echoed back to us by the window
    }
  });
  // Both scripts start at document_start, in no promised order: ask the hook
  // to replay anything it saw before this listener existed.
  window.postMessage(envelope({ kind: 'hello' }), '/');
}

/**
 * Resource Timing lists every URL this document fetched, whichever host served
 * it and whether the request came from fetch, XHR or a <video>. It sees what
 * the page hook can miss (a request made before the hook ran, a player in a
 * worker) and what the network observer cannot (a CDN host with no grant).
 */
function watchResourceTiming(): void {
  if (typeof PerformanceObserver !== 'function') return;
  try {
    new PerformanceObserver((list) => {
      if (rememberResourceTiming(list.getEntries())) reportSoon();
    }).observe({ type: 'resource', buffered: true });
  } catch (err) {
    log.debug('Resource Timing unavailable', err instanceof Error ? err.message : String(err));
  }
}

/** Keep the current route's requests; one from before the route began belongs to an old one. */
function rememberResourceTiming(entries: readonly PerformanceEntry[]): boolean {
  let added = false;
  for (const entry of entries) {
    if (entry.startTime < route.startedAtPerf) continue;
    added = rememberFetched(entry.name) || added;
  }
  return added;
}

function resourceTimingSoFar(): readonly PerformanceEntry[] {
  try {
    return performance.getEntriesByType('resource');
  } catch {
    return [];
  }
}

/**
 * Where the route began, when this script arrives late. Registered, it runs at
 * document_start while the document is still loading, and the route began
 * with the document (see `route`). Injected right after the user granted the
 * site (permissions/content-scripts.ts `injectNow`), it runs in a page that
 * may have been open for an hour, and Resource Timing lists everything the
 * document fetched in that hour: on a single-page app, the media of routes the
 * user has since left, with nothing to say which route a request was for.
 *
 * The rule: the route began with the document only when the page can vouch
 * that the document has shown one route all its life (`hasShownOneRoute`,
 * which reads the session history). Otherwise it begins now: what the page
 * fetched before is dropped, what the DOM shows is reported as always, and
 * what the player fetches from now on is kept.
 *
 * Why drop rather than keep when unsure: kept, an old route's video is listed
 * under the current page's title, can be what "Best download" picks, and is
 * saved under the wrong name - a wrong file, silently. Dropped, the cost is a
 * manifest fetched before the grant, and after a grant the popup already asks
 * the user to reload the page (popup-controller `reloadAfterGrant`), which
 * brings it back.
 */
function startLateRoute(): void {
  if (document.readyState === 'loading') return; // registered, at document_start: on time
  let entries: readonly SessionEntry[] | undefined;
  try {
    entries = navigationApi(window)?.entries?.();
  } catch {
    entries = undefined; // unreadable: only history.length is left to vouch
  }
  if (hasShownOneRoute(entries, history.length)) return;
  route.startedAt = Date.now();
  route.startedAtPerf = performance.now();
}

function watchDom(): void {
  const observer = new MutationObserver((records) => {
    // Only structural changes that could add media are worth a report.
    const relevant = records.some((record) =>
      [...record.addedNodes].some(
        (node) =>
          node instanceof Element &&
          (node.matches('video, audio, source, iframe') ||
            node.querySelector('video, audio, source') !== null),
      ),
    );
    if (relevant) reportSoon();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Playback is the moment most players finally request their manifest.
  for (const event of ['play', 'loadedmetadata', 'durationchange']) {
    document.addEventListener(event, () => reportSoon(), { capture: true, passive: true });
  }
}

/**
 * "Scan again" in the popup. Replying only after the worker has stored our
 * report - with the worker's own reply, which says when - is what lets the
 * worker scan fresh DOM state instead of stale state.
 */
function listenToBackground(): void {
  browserApi().runtime.onMessage((raw) => {
    const request = raw as { type?: unknown; requestId?: unknown } | null;
    if (request?.type !== 'REQUEST_SCAN' || !started) return undefined;
    const requestId = typeof request.requestId === 'string' ? request.requestId : undefined;
    if (requestId === undefined) return sendReport();
    if (answered?.requestId !== requestId) answered = { requestId, reply: sendReport() };
    return answered.reply;
  });
}

function start(): void {
  started = true;
  watchDom();
  void sendReport();
  setTimeout(() => void sendReport(), LATE_PASS_MS);
}

/**
 * A prerendered page is loaded but not shown, and it is not the tab's page
 * until the user navigates to it. Reporting it would mix its media into the
 * page still on screen, so it stays silent until it is shown - while still
 * listening, so nothing it fetched meanwhile is lost.
 */
function whenShownAndParsed(run: () => void): void {
  if ((document as Document & { prerendering?: boolean }).prerendering === true) {
    document.addEventListener('prerenderingchange', () => whenShownAndParsed(run), { once: true });
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}

if (alreadyLoaded) {
  log.debug('content script already running in this document; second load ignored');
} else {
  startLateRoute();
  listenToPageHook();
  watchResourceTiming();
  listenToBackground();
  // Back to this page from the back-forward cache: no new document, no request
  // the network observer could see - only this event says the page is back.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) newRoute(false);
  });
  whenShownAndParsed(start);
}
