/**
 * MAIN-world page hook.
 *
 * Registered as a content script in the page's own JavaScript world at
 * document_start (permissions/content-scripts.ts), so it is installed before
 * any page script runs. It is the only place that can see:
 *   - fetch() and XMLHttpRequest URLs that never touch the DOM - on most sites
 *     the only sighting of a manifest served from a CDN host the user has not
 *     granted, which the network observer therefore cannot see
 *   - MediaSource use: the reason a <video> shows `blob:` and nothing else
 *   - MediaKeys being attached to a player: the content is DRM protected
 *   - a single-page app moving to another route, by the History API, by a
 *     hash route or by the Navigation API - the moment it happens
 *
 * SECURITY - this is the most exposed file in the extension:
 *   - it has NO access to extension APIs and must never be given any
 *   - it only ever calls window.postMessage with our envelope (core/hook-protocol.ts)
 *   - the content script re-validates every message before using it
 *   - it never reads request bodies, response bodies, cookies or request headers;
 *     of a response it reads only the Content-Type
 *   - every patch is a Proxy around the original, so page code that inspects
 *     `fetch.toString()` or `open.length` still sees the native function
 *
 * Failure mode: a hook that throws while installing is skipped; the others and
 * the page carry on.
 */
import { envelope, type HookMessage, parseHookMessage } from '../core/hook-protocol.ts';
import { MAX_HOOK_URLS } from '../core/limits.ts';
import { classifyMediaUrl } from '../media/format.ts';
import { navigationApi, routeOf } from './routes.ts';

/**
 * What this page has shown so far, kept so it can be replayed to a content
 * script that starts listening after the page began (both run at
 * document_start, in an order the browser does not promise). Cleared when the
 * page moves to another route.
 */
const seen = {
  route: routeOf(location.href),
  urls: new Map<string, HookMessage>(),
  mse: false,
  keys: false,
};

function post(message: HookMessage): void {
  try {
    // '/' = this document's own origin, which also works in a sandboxed frame
    // whose origin is opaque (where `location.origin` would never match).
    window.postMessage(envelope(message), '/');
  } catch {
    // A page can break postMessage; there is nothing to report and no one to tell.
  }
}

/**
 * Post a media URL once per route; players re-fetch manifests constantly.
 * Stream segments are never posted: a playing video fetches thousands, and
 * counting them would fill the memory below and silence the hook for the
 * rest of the route. Past the cap the oldest URL is forgotten, never the new.
 */
function reportUrl(url: string, mimeType?: string): void {
  const media = classifyMediaUrl(url, mimeType);
  if (!media || media.isSegment) return;
  const key = mimeType ? `${url} ${mimeType}` : url;
  if (seen.urls.has(key)) return;
  if (seen.urls.size >= MAX_HOOK_URLS) {
    const oldest = seen.urls.keys().next();
    if (!oldest.done) seen.urls.delete(oldest.value);
  }
  const message: HookMessage = mimeType ? { kind: 'url', url, mimeType } : { kind: 'url', url };
  seen.urls.set(key, message);
  post(message);
}

function reportFlag(kind: 'mse' | 'keys'): void {
  if (seen[kind]) return;
  seen[kind] = true;
  post({ kind });
}

function toAbsolute(input: unknown): string | undefined {
  try {
    if (typeof input === 'string') return new URL(input, document.baseURI).toString();
    if (input instanceof URL) return input.toString();
    if (input instanceof Request) return input.url;
  } catch {
    // An unparseable URL is the page's problem; the request itself proceeds.
  }
  return undefined;
}

/**
 * Replace `owner[key]` with a Proxy that runs `observe` around each call.
 * `observe` gets the call's arguments and its result and must never throw
 * into the page; the original is always called exactly once, with the page's
 * own `this` and arguments, and its result is returned untouched.
 */
function wrapMethod<T extends object>(
  owner: T,
  key: keyof T,
  observe: (args: unknown[], result: unknown, thisArg: unknown) => void,
): void {
  const original = owner[key];
  if (typeof original !== 'function') return;
  owner[key] = new Proxy(original, {
    apply(target, thisArg, args: unknown[]) {
      const result = Reflect.apply(target, thisArg, args);
      try {
        observe(args, result, thisArg);
      } catch {
        // Instrumentation must never change what the page's call does.
      }
      return result;
    },
  }) as T[keyof T];
}

function hookFetch(): void {
  wrapMethod(window, 'fetch', (args, result) => {
    const url = toAbsolute(args[0]);
    if (!url) return;
    reportUrl(url);
    // Extensionless manifest URLs (/api/stream) are recognised by their type.
    (result as Promise<Response>)
      .then((response) => reportUrl(url, response.headers.get('content-type') ?? undefined))
      .catch(() => undefined);
  });
}

function hookXhr(): void {
  const proto = window.XMLHttpRequest?.prototype;
  if (!proto) return;
  const urlOf = new WeakMap<XMLHttpRequest, string>();
  const watched = new WeakSet<XMLHttpRequest>();

  wrapMethod(proto, 'open', (args, _result, xhr) => {
    const request = xhr as XMLHttpRequest;
    const url = toAbsolute(args[1]);
    if (!url) return;
    urlOf.set(request, url);
    reportUrl(url);
    // One listener per object, not per open(): players reuse XHR objects.
    // Not `{ once: true }` - open() itself fires readystatechange (state 1),
    // which would spend the listener before the headers ever arrive.
    if (watched.has(request)) return;
    watched.add(request);
    request.addEventListener('readystatechange', () => {
      if (request.readyState !== XMLHttpRequest.HEADERS_RECEIVED) return;
      const current = urlOf.get(request);
      const type = request.getResponseHeader('content-type');
      if (current && type) reportUrl(current, type);
    });
  });
}

/** A SourceBuffer means the bytes are appended by JavaScript: there is no single file. */
function hookMediaSource(): void {
  const proto = window.MediaSource?.prototype;
  if (proto) wrapMethod(proto, 'addSourceBuffer', () => reportFlag('mse'));
  wrapMethod(URL, 'createObjectURL', (args) => {
    if (typeof MediaSource === 'function' && args[0] instanceof MediaSource) reportFlag('mse');
  });
}

/**
 * MediaKeys attached to a player = a licence is being negotiated = DRM (PRD s42).
 * Only the attachment counts. `navigator.requestMediaKeySystemAccess` does not:
 * players and fingerprinting scripts call it just to ask what the browser
 * supports, and treating that as DRM called clear videos "protected".
 */
function hookMediaKeys(): void {
  const proto = window.HTMLMediaElement?.prototype;
  if (proto) {
    wrapMethod(proto, 'setMediaKeys', (args) => {
      if (args[0]) reportFlag('keys');
    });
  }
}

/**
 * A single-page app moving to another route. That is a new page for the user,
 * so what was found on the old route is dropped. Which addresses are another
 * route is `routeOf`'s rule (inject/routes.ts): a new path or query, or a new
 * hash route (`#/video/2`, `#!/video/2`); an in-page anchor (`#comments`,
 * `#t=90`, a placeholder `<a href="#!">`) is not.
 *
 * Routers move in different ways, and each signal below misses some of them:
 *   pushState       History API routers
 *   popstate        back and forward between entries
 *   hashchange      hash routers: `location.hash = ...`, `<a href="#/...">`
 *   Navigation API  `navigation.navigate()` and the navigations a router
 *                   intercepts (followNavigationApi, below)
 * They also overlap: in Chromium one pushState fires the Navigation API's
 * events as well, and a fragment change fires popstate and hashchange. So no
 * signal posts on its own say-so: each asks "is the page on another route
 * now?", the first to see the move posts it, and the others find the page
 * already on that route. One move, one `navigate`.
 *
 * replaceState is NOT a route change: sites use it to tidy the address in
 * place (tracking parameters, filters), and treating it as one threw away the
 * manifest the page had just fetched. A Navigation API navigation that
 * replaces its entry is the same thing said another way. (Without the
 * Navigation API nothing says whether a hash change replaced its entry, so
 * there a `location.replace('#/...')` counts as a move.)
 *
 * `navigate` carries the moment the address changed: routers fetch the new
 * route's media in the same task, before the content script can hear about
 * the move. The clock is taken now, before any page script could patch it.
 */
function hookRoutes(): void {
  const now = performance.now.bind(performance);
  const routeMayHaveChanged = () => {
    const route = routeOf(location.href, seen.route);
    if (route === seen.route) return;
    seen.route = route;
    seen.urls.clear();
    seen.mse = false;
    seen.keys = false;
    post({ kind: 'navigate', at: now() });
  };
  // Same route, new address: remember it, so a later move to this very
  // address is not mistaken for a route change.
  const addressTidied = () => {
    seen.route = routeOf(location.href, seen.route);
  };
  wrapMethod(history, 'pushState', routeMayHaveChanged);
  wrapMethod(history, 'replaceState', addressTidied);
  window.addEventListener('popstate', routeMayHaveChanged);
  window.addEventListener('hashchange', routeMayHaveChanged);
  followNavigationApi(routeMayHaveChanged, addressTidied);
}

/**
 * The Navigation API (Chromium), when the page has it. Its events report every
 * same-document navigation whoever starts it - including one a router
 * intercepts with `event.intercept()`, which changes the address without
 * touching the History API at all. Listened to only; nothing of it is patched.
 *
 *   currententrychange  the new address has committed. It fires before an
 *                       intercepting router's handler runs, so before the new
 *                       route fetches anything: the route starts here. Its
 *                       `navigationType` says whether the entry was replaced.
 *   navigatesuccess     the navigation finished; a backstop, and a no-op when
 *                       currententrychange has already seen the move.
 *
 * `navigate` itself is not acted on: it fires before the address changes, for
 * navigations another listener may still cancel or that leave the document.
 */
function followNavigationApi(moved: () => void, tidied: () => void): void {
  const navigation = navigationApi(window);
  if (!navigation) return;
  navigation.addEventListener('currententrychange', (event) => {
    if ((event as Event & { navigationType?: unknown }).navigationType === 'replace') tidied();
    else moved();
  });
  navigation.addEventListener('navigatesuccess', moved);
}

/** The content script is ready: tell it everything seen before it was listening. */
function answerHello(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || parseHookMessage(event.data)?.kind !== 'hello') return;
    if (seen.mse) post({ kind: 'mse' });
    if (seen.keys) post({ kind: 'keys' });
    for (const message of seen.urls.values()) post(message);
  });
}

/**
 * The hook is registered for future page loads and also injected on demand
 * right after a grant, so it can arrive twice in one document; wrapping every
 * method twice would double every message. (A page that sets this marker
 * itself only hides its own media from MediaGrab, which it could do anyway.)
 */
const INSTALLED = Symbol.for('mediagrab.page-hook');
const host = window as unknown as Record<symbol, boolean>;
if (!host[INSTALLED]) {
  host[INSTALLED] = true;
  for (const install of [
    hookFetch,
    hookXhr,
    hookMediaSource,
    hookMediaKeys,
    hookRoutes,
    answerHello,
  ]) {
    try {
      install();
    } catch {
      // One failed hook must not stop the others, and must not break the page.
    }
  }
}
