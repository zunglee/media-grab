/**
 * Content-script registration.
 *
 * MediaGrab has no declarative `content_scripts` block, because that would mean
 * declaring `<all_urls>` at install time (ARCHITECTURE.md D6). Instead two
 * scripts are registered dynamically for exactly the origins the user has
 * granted, so they run at document_start on every future navigation to those
 * sites and nowhere else:
 *
 *   page-hook.js  MAIN world: the page's own JavaScript context, where fetch,
 *                 MediaSource and MediaKeys can be observed. Registered rather
 *                 than injected with a <script> tag, so it is in place before
 *                 any page script runs, and so it needs no web-accessible file
 *                 (which any site could probe to learn MediaGrab is installed).
 *   content.js    ISOLATED world: DOM scanning and the link to the worker.
 *
 * Called on worker start-up and whenever the user grants a new origin.
 */
import type { ScriptWorld } from '../browser/api.ts';
import { browserApi } from '../browser/index.ts';
import { createLogger } from '../core/log.ts';

const log = createLogger('content-scripts');

interface PageScript {
  id: string;
  file: string;
  world: ScriptWorld;
}

/** The hook first: it must be listening before the page's own scripts run. */
const PAGE_SCRIPTS: readonly PageScript[] = [
  { id: 'mediagrab-page-hook', file: 'page-hook.js', world: 'MAIN' },
  { id: 'mediagrab-content', file: 'content.js', world: 'ISOLATED' },
];

/**
 * Only http(s) origins can host a content script; `<all_urls>` and other
 * schemes are filtered out so registration cannot fail on one bad entry.
 */
export function scriptMatchesFor(origins: string[]): string[] {
  const matches = new Set<string>();
  for (const origin of origins) {
    if (origin === '<all_urls>' || origin === '*://*/*') {
      matches.add('http://*/*');
      matches.add('https://*/*');
      continue;
    }
    if (origin.startsWith('http://') || origin.startsWith('https://')) matches.add(origin);
  }
  return [...matches];
}

/** The origin patterns the user has granted, ready for a listener filter. */
export async function grantedMatchPatterns(): Promise<string[]> {
  try {
    return scriptMatchesFor(await browserApi().permissions.getOrigins());
  } catch {
    return [];
  }
}

/**
 * Make the registered scripts match exactly the granted origins.
 * Safe to call repeatedly; it replaces rather than accumulates.
 */
export async function syncContentScriptRegistration(): Promise<void> {
  const api = browserApi();
  const matches = await grantedMatchPatterns();

  // Called on every worker start. Re-registering then would open a gap in
  // which a page (an iframe loading as the worker wakes, a restored tab) gets
  // no scripts at all, so an unchanged registration is left as it is.
  let registered: Array<{ id: string; matches: string[] }> = [];
  try {
    registered = await api.scripting.registeredContentScripts();
  } catch (err) {
    log.debug('could not read registrations', err instanceof Error ? err.message : String(err));
  }
  if (PAGE_SCRIPTS.every((script) => registeredFor(registered, script.id, matches))) return;

  for (const script of PAGE_SCRIPTS) {
    if (!registered.some((entry) => entry.id === script.id)) continue;
    await api.scripting.unregisterContentScript(script.id).catch(() => undefined);
  }

  if (matches.length === 0) {
    log.info('no granted origins; content scripts not registered');
    return;
  }

  for (const script of PAGE_SCRIPTS) {
    try {
      await api.scripting.registerContentScript({
        id: script.id,
        matches,
        files: [script.file],
        allFrames: true,
        runAt: 'document_start',
        world: script.world,
      });
    } catch (err) {
      log.error(
        `${script.file} registration failed`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  log.info(`content scripts registered for ${matches.length} origin pattern(s)`);
}

/**
 * Inject into a tab right now, for the case where the user has just granted
 * access and does not want to reload before seeing anything. Both scripts
 * guard against running twice, so this is safe on an already-injected tab.
 * Injected this late, the hook sees only what the page does from now on;
 * Resource Timing still lists what it fetched before. Returns false when we
 * do not have permission for that tab.
 */
export async function injectNow(tabId: number): Promise<boolean> {
  try {
    for (const script of PAGE_SCRIPTS) {
      await browserApi().scripting.executeScript({
        tabId,
        files: [script.file],
        allFrames: true,
        world: script.world,
      });
    }
    return true;
  } catch (err) {
    log.debug('injection refused', err instanceof Error ? err.message : String(err));
    return false;
  }
}

function registeredFor(
  registered: Array<{ id: string; matches: string[] }>,
  id: string,
  matches: string[],
): boolean {
  const entry = registered.find((script) => script.id === id);
  if (!entry) return matches.length === 0;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((m) => b.includes(m));
  return same(entry.matches, matches);
}
