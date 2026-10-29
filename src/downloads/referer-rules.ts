/**
 * The page as Referer, on the requests MediaGrab itself makes (ARCHITECTURE.md
 * D18).
 *
 * Many CDNs refuse a media request that does not name the page it is for:
 * the "hot-link protection" 403. `fetch` cannot send a Referer - it is a
 * forbidden header, dropped silently - so the header is set by the browser,
 * through a session `declarativeNetRequest` rule, and only:
 *
 *   - on requests not tied to a tab (TAB_ID_NONE): MediaGrab's own. A site's
 *     own service worker is not tied to a tab either, so its requests to the
 *     same host during a task carry the page too - to a host that already
 *     sees it from MediaGrab;
 *   - to the hosts a task is actually fetching from (and their subdomains:
 *     `requestDomains` matches those);
 *   - where MediaGrab has host access - the browser enforces that for
 *     `declarativeNetRequestWithHostAccess`, so a rule for a host the user has
 *     not granted is simply inert;
 *   - while a task needs it: each host's rule is counted by its users and
 *     removed when the last one finishes. A killed worker's rules are cleared
 *     by the next one before it restores the queue (background/services.ts).
 *
 * MediaGrab adds no cookies (D18 says why). One rule per host carries the most
 * recent page's URL; two tabs downloading from one CDN at once share it.
 */
import { browserApi } from '../browser/index.ts';
import { createLogger } from '../core/log.ts';

const log = createLogger('referer-rules');

/** Rule ids are ours alone (no other declarativeNetRequest use), counted from here. */
const FIRST_RULE_ID = 1;

interface HostRule {
  id: number;
  users: number;
}

export class RefererRules {
  private readonly rules = new Map<string, HostRule>();
  private nextId = FIRST_RULE_ID;
  private cleared: Promise<void> | null = null;

  /**
   * Send `pageUrl` as the Referer to every host in `urls` until the returned
   * release function is called. Calling it more than once is harmless.
   */
  async hold(urls: string[], pageUrl: string): Promise<() => void> {
    const rules = browserApi().headerRules;
    if (!rules.isSupported() || !isHttp(pageUrl)) return () => undefined;
    await this.clearLeftovers();

    const hosts = [...new Set(urls.flatMap((url) => hostOf(url) ?? []))];
    for (const host of hosts) {
      const rule = this.rules.get(host) ?? { id: this.nextId++, users: 0 };
      rule.users += 1;
      this.rules.set(host, rule);
      // Rewritten every time: the most recent page is the one to name.
      await rules.setReferer({ id: rule.id, host, referer: pageUrl }).catch((err) => {
        log.debug('could not set the Referer rule', String(err));
      });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      void this.release(hosts);
    };
  }

  private async release(hosts: string[]): Promise<void> {
    const gone: number[] = [];
    for (const host of hosts) {
      const rule = this.rules.get(host);
      if (!rule) continue;
      rule.users -= 1;
      if (rule.users <= 0) {
        this.rules.delete(host);
        gone.push(rule.id);
      }
    }
    await browserApi()
      .headerRules.remove(gone)
      .catch(() => undefined);
  }

  /**
   * A previous worker's rules outlive it (session rules last until the browser
   * restarts), still naming its last page to that host. Called at start-up,
   * and before the first rule as a safety net; runs once.
   */
  clearLeftovers(): Promise<void> {
    this.cleared ??= (async () => {
      const rules = browserApi().headerRules;
      const stale = await rules.ids().catch(() => [] as number[]);
      await rules.remove(stale).catch(() => undefined);
    })();
    return this.cleared;
  }
}

function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return isHttp(url) ? parsed.hostname : undefined;
  } catch {
    return undefined;
  }
}

function isHttp(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://');
}
