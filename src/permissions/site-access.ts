/**
 * Per-site access (PRD s43).
 *
 * MediaGrab does not ask for "read and change all your data on all websites" at
 * install time. It ships with `activeTab` plus optional host permissions, and
 * asks for one origin at a time, from a user gesture, with the reason on screen.
 * The popup's "Enable on this site" and the options page's "Allow on all sites"
 * both end here.
 *
 * The cost of that choice, stated honestly in the UI: the network observer only
 * sees requests made AFTER the permission is granted, so the first grant on a
 * site needs a page reload before detection is complete.
 */
import { browserApi } from '../browser/index.ts';
import { createLogger } from '../core/log.ts';

const log = createLogger('permissions');

/** Schemes we can never operate on, whatever the user clicks. */
const UNSUPPORTED_SCHEMES = [
  'chrome:',
  'chrome-extension:',
  'moz-extension:',
  'about:',
  'edge:',
  'view-source:',
  'file:',
];

const ALL_SITES = '*://*/*';

/**
 * API permissions a site grant brings with it. `webRequest` does nothing
 * without a host permission, so the Chrome build lists it as optional and asks
 * for it in the same click as the origin (ARCHITECTURE.md D6).
 */
const API_PERMISSIONS_WITH_A_SITE = ['webRequest'];

/**
 * Only the ones this build lists as optional. Firefox declares `webRequest` as
 * required, and Firefox rejects the WHOLE `permissions.request` when it names a
 * permission outside `optional_permissions` - origin included - so asking for
 * it there would make every grant silently fail.
 *
 * Synchronous on purpose: `permissions.request` must be reached with no `await`
 * before it, or the browser no longer counts the call as part of the click.
 */
function apiPermissionsToAskFor(): string[] {
  const optional = browserApi().runtime.optionalApiPermissions();
  return API_PERMISSIONS_WITH_A_SITE.filter((permission) => optional.includes(permission));
}

export function originPatternFor(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (UNSUPPORTED_SCHEMES.includes(parsed.protocol)) return null;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

export async function hasSiteAccess(url: string): Promise<boolean> {
  const pattern = originPatternFor(url);
  return pattern ? holds(pattern) : false;
}

/** Must be called from a user gesture (a click in the popup or options page). */
export async function requestSiteAccess(url: string): Promise<boolean> {
  const pattern = originPatternFor(url);
  return pattern ? ask(pattern) : false;
}

/**
 * A host that refused a download and holds no grant (D18): both schemes, so a
 * CDN serving plain http is covered too. The host comes from the worker's
 * `URL.hostname`; anything else is refused. Must be called from a user gesture.
 */
export async function requestHostAccess(host: string): Promise<boolean> {
  return HOSTNAME.test(host) ? ask(`*://${host}/*`) : false;
}

/**
 * A hostname as `URL.hostname` gives it: labels (underscores occur in real CDN
 * names), an optional final dot, or a bracketed IPv6 address. Nothing that
 * could widen the pattern - no `*`, `/` or scheme.
 */
const HOSTNAME = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])$/i;

/** Must be called from a user gesture. */
export async function requestAllSitesAccess(): Promise<boolean> {
  return ask(ALL_SITES);
}

export async function hasAllSitesAccess(): Promise<boolean> {
  return holds(ALL_SITES);
}

async function holds(pattern: string): Promise<boolean> {
  try {
    return await browserApi().permissions.contains([pattern], apiPermissionsToAskFor());
  } catch {
    return false;
  }
}

async function ask(pattern: string): Promise<boolean> {
  try {
    const granted = await browserApi().permissions.request([pattern], apiPermissionsToAskFor());
    log.info(granted ? `granted access to ${pattern}` : `access to ${pattern} declined`);
    return granted;
  } catch (err) {
    log.warn('permission request failed', err instanceof Error ? err.message : String(err));
    return false;
  }
}
