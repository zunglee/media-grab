/**
 * What a route is, for the page hook and the content script (ARCHITECTURE D17).
 *
 * A single-page app changes what is on screen without loading a new document,
 * and the media found on the old route must not be offered on the new one. The
 * address is the one thing every router changes, but not every change of the
 * address is a new route:
 *
 *   /watch/1       -> /watch/2              new route (History API router)
 *   /app#/video/1  -> /app#/video/2         new route (hash router)
 *   /app#!/video/1 -> /app#!/video/2        new route (hashbang router)
 *   /watch/1       -> /watch/1#comments     same route: an in-page anchor
 *   /watch/1       -> /watch/1#t=90         same route: a media fragment
 *   /watch/1       -> /watch/1#!            same route: a placeholder link
 *
 * `routeOf` names the route an address is on, and two addresses are on the
 * same route exactly when it names them alike. How the address changed matters
 * too (replaceState tidies the address of the same route); that part belongs
 * to the page hook (inject/page-hook.ts), which sees how.
 *
 * Imported by both the MAIN-world hook and the ISOLATED-world content script,
 * so it must stay free of extension APIs and of anything a page could patch.
 */
import { withoutFragment } from '../media/fingerprint.ts';

/**
 * Does this fragment name a route of a hash-routed app, rather than a place on
 * the page? `hash` as `location.hash` gives it (`#/video/2`), or without the '#'.
 *
 * The heuristic: a route begins with '/' (`#/video/2`, `#/`, `#/search?q=cats`)
 * or with the hashbang '!' (`#!/video/2`, `#!video`, `#!`). Those are the forms
 * hash routers write - Angular, Vue and React in hash mode write `#/...`,
 * hashbang routers `#!...` - and forms a page's own fragments do not take: an
 * element id (`#top`, `#comments`), a media fragment (`#t=90`) or the empty
 * fragment (`#`, "top of the page") is a name, not a path.
 *
 * Deliberately not recognised: routers that write a bare path (`#video/2`,
 * Backbone's default). From the fragment alone that cannot be told from an
 * element id, and D17 names the `#/` and `#!` forms as the target.
 */
export function isRouteHash(hash: string): boolean {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  return fragment.startsWith('/') || fragment.startsWith('!');
}

/**
 * The route an address is on. With no fragment, or a route fragment, that is
 * the address itself. With an anchor fragment it is the address without it -
 * except that an anchor on the page the app is already showing keeps that
 * route: `#/video/2` -> `#comments` is a jump inside video 2 (or a stray link
 * the router ignores), not a move to the app's root. `current` is the route
 * the page is on before this address, when known.
 *
 * An empty route (`#/`, `#!`, `#!/`) is the app's root, which a page not on a
 * hash route already is: there it is an anchor. That is also what
 * `<a href="#!">` and `<a href="#/">` are on most sites - placeholder links
 * for a click handler - and clicking one must not wipe the media on screen.
 * From a hash route (`#/video/2` -> `#/`) it is a real move home.
 */
export function routeOf(href: string, current?: string): string {
  const hash = hashOf(href);
  if (!hash) return href;
  // `#/`, `#!`, `#!/`: a route with nothing after it, the root.
  const root = /^#!?\/?$/.test(hash);
  if (isRouteHash(hash) && (!root || isRouteHash(hashOf(current ?? '')))) return href;
  const base = href.slice(0, href.length - hash.length);
  return current !== undefined && withoutFragment(current) === base ? current : base;
}

/** The fragment of an address, '#' included; '' when it has none. */
function hashOf(href: string): string {
  const at = href.indexOf('#');
  return at === -1 ? '' : href.slice(at);
}

/** One entry of a frame's session history, as the Navigation API lists it. */
export interface SessionEntry {
  readonly url: string | null;
  /** The entry belongs to the document asking, not to another page. */
  readonly sameDocument: boolean;
}

/**
 * Whether this document can have been on one route all its life, going by
 * what the page can tell. The content script asks when it arrives late
 * (content/index.ts `startLateRoute`): if so, everything the document fetched
 * belongs to the route on screen.
 *
 * `entries` is `navigation.entries()` (the Navigation API, Chromium): the
 * frame's session history, each entry saying whether it belongs to this very
 * document. Every same-document entry is a route the document has shown -
 * entries after the current one too, since the user came back from them - so
 * the document has shown one route when all of them are on one route. An
 * entry with no URL vouches for nothing.
 *
 * Without the Navigation API (or when it lists nothing), `historyLength`
 * (`history.length`) is the only witness left: a tab with a single history
 * entry has never pushed a route, and a replaceState is not a route change.
 * Anything else cannot be told apart from a document that has moved on.
 */
export function hasShownOneRoute(
  entries: readonly SessionEntry[] | undefined,
  historyLength: number,
): boolean {
  if (!entries || entries.length === 0) return historyLength === 1;
  let route: string | undefined;
  for (const entry of entries) {
    if (!entry.sameDocument) continue;
    if (typeof entry.url !== 'string') return false;
    const next = routeOf(entry.url, route);
    if (route !== undefined && next !== route) return false;
    route = next;
  }
  return true;
}

/** The parts of the Navigation API (`window.navigation`) this extension uses. */
export interface NavigationApi {
  addEventListener(type: string, listener: (event: Event) => void): void;
  entries?(): readonly SessionEntry[];
}

/**
 * `window.navigation` when the browser has the Navigation API (Chromium 102+),
 * otherwise undefined. Firefox and Safari without it fall back to the History
 * API signals, which every browser has.
 */
export function navigationApi(win: object): NavigationApi | undefined {
  const candidate = (win as { navigation?: unknown }).navigation;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const api = candidate as NavigationApi;
  return typeof api.addEventListener === 'function' ? api : undefined;
}
