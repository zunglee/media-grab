/**
 * The worker's collaborators, built once per worker lifetime and handed to
 * whoever needs them (message router, shortcuts, menus). Nothing in here
 * listens to anything; wiring listeners is index.ts's job.
 *
 * Settings and the download manager are created on first use: most worker
 * wake-ups are a page report or a tab closing, and neither needs them. The
 * exception is saved download work (D16): index.ts starts the manager at every
 * wake-up while any is left - a queued, running or failed row - so the new
 * worker takes charge of it.
 */

import { browserApi } from '../browser/index.ts';
import { setDebugLogging } from '../core/log.ts';
import type { ScanResult } from '../core/types.ts';
import { NetworkObserver } from '../detection/network.ts';
import { DownloadManager } from '../downloads/manager.ts';
import { RefererRules } from '../downloads/referer-rules.ts';
import { normalizeUrl, withoutFragment } from '../media/fingerprint.ts';
import { pickBestDownload } from '../media/quality.ts';
import { injectNow } from '../permissions/content-scripts.ts';
import { loadSettings, type Settings } from '../storage/settings.ts';
import { attachDownloadHooks } from './download-hooks.ts';
import { closeLeftoverDocument, closeOffscreenWhenIdle } from './offscreen-lifetime.ts';
import { carryDownloads, hasSavedDownloads, type QueueStorage } from './queue-store.ts';
import { Scanner } from './scanner.ts';
import { TabStore, TOP_FRAME } from './tab-store.ts';

export class BackgroundServices {
  readonly network = new NetworkObserver();
  readonly tabs = new TabStore(browserApi().storage.session);
  readonly scanner = new Scanner(this.tabs, this.network);

  private settingsPromise: Promise<Settings> | null = null;
  private managerPromise: Promise<DownloadManager> | null = null;

  settings(): Promise<Settings> {
    this.settingsPromise ??= this.readSettings().catch((err: unknown) => {
      this.settingsPromise = null; // try again next time rather than caching the failure
      throw err;
    });
    return this.settingsPromise;
  }

  /** The options page saved new settings. */
  async reloadSettings(): Promise<Settings> {
    this.settingsPromise = null;
    const settings = await this.settings();
    if (this.managerPromise) (await this.managerPromise).updateSettings(settings);
    return settings;
  }

  /** Something new was seen on the tab: rescan it, if the user wants that. */
  async autoScan(tabId: number): Promise<void> {
    if ((await this.settings()).general.autoScan) await this.scanner.scan(tabId);
  }

  /**
   * The manager, if there is one or there is saved work for one: after a
   * worker restart, update or browser restart, the saved queue has to be taken
   * charge of again (queued tasks resume, finished files reach history). A
   * browser download event with nothing saved is the user's own download, and
   * no reason to start one.
   */
  async downloadsIfNeeded(): Promise<DownloadManager | undefined> {
    if (this.managerPromise) return this.managerPromise;
    return (await hasSavedDownloads(this.queueStorage())) ? this.downloads() : undefined;
  }

  downloads(): Promise<DownloadManager> {
    this.managerPromise ??= this.createManager().catch((err: unknown) => {
      this.managerPromise = null; // a failed start must not break downloads for good
      throw err;
    });
    return this.managerPromise;
  }

  private async createManager(): Promise<DownloadManager> {
    // A killed worker's Referer rules still name its last page; clear them
    // before the restore sets the ones the recovered tasks need.
    const referers = new RefererRules();
    await referers.clearLeftovers();
    const manager = new DownloadManager(await this.settings(), undefined, referers);
    // Hooks first: a file that finished while no worker ran is completed during
    // the restore, and must still reach history.
    attachDownloadHooks(manager, () => this.settings());
    await carryDownloads(manager, this.queueStorage(), { beforeRestore: closeLeftoverDocument });
    closeOffscreenWhenIdle(manager);
    return manager;
  }

  private queueStorage(): QueueStorage {
    const { session, local } = browserApi().storage;
    return { session, local };
  }

  async activeTabId(): Promise<number | undefined> {
    const [tab] = await browserApi().tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  }

  /**
   * The keyboard shortcut and the context menu: the same choice the popup's
   * "Best download" button makes, from the last scan (or a fresh one). A
   * right-click on a particular video narrows the choice to that video, if
   * the scan has it; the page's best is only the fallback.
   */
  async downloadBest(tabId: number, clickedUrl?: string): Promise<void> {
    // The stored scan describes the page the tab showed when it was made. If
    // the address has changed since (a replaceState, or a site MediaGrab cannot
    // read), ask the page for a fresh report; if the page still is not the one
    // the scan describes, the scan is about another page: download nothing.
    const tab = await browserApi().tabs.get(tabId);
    const isOnScreen = (scan: ScanResult) =>
      !tab || withoutFragment(scan.pageUrl) === withoutFragment(tab.url);
    let scan = await this.tabs.lastScan(tabId);
    if (!scan || !isOnScreen(scan)) scan = await this.freshScan(tabId);
    if (!isOnScreen(scan)) return;
    const clicked = clickedUrl ? normalizeUrl(clickedUrl) : undefined;
    const thatOne = scan.candidates.filter((candidate) => normalizeUrl(candidate.url) === clicked);
    const best = pickBestDownload(thatOne) ?? pickBestDownload(scan.candidates);
    if (!best) return;
    // A stream that only exists as separate video and audio: both files (D20).
    const manager = await this.downloads();
    manager.enqueue(best.candidate, best.variant);
    if (best.audio) manager.enqueue(best.candidate, best.audio);
  }

  /**
   * A scan of the page as it is now ("Scan again"). Every frame is asked for a
   * fresh report first, and the scan waits for the top frame's to be stored.
   *
   *  - Right after a grant there is no content script in the tab yet, so both
   *    scripts are injected (idempotent: they ignore a second load).
   *  - Every frame re-reports, so an embedded player is rescanned too; the top
   *    frame gets two copies of the request and, seeing one request id,
   *    answers with one report.
   *  - The id is random, not a counter: a counter restarts with every worker,
   *    and a frame that answered "scan-1" before would answer again with its
   *    old report.
   *  - If the top frame's report already started a scan (auto-scan), the scan
   *    joins it rather than running a second one.
   */
  async freshScan(tabId: number): Promise<ScanResult> {
    await injectNow(tabId);
    const request = { type: 'REQUEST_SCAN', requestId: crypto.randomUUID() };
    const api = browserApi();
    void api.tabs.sendMessage(tabId, request);
    const reply = (await api.tabs.sendMessage(tabId, request, { frameId: TOP_FRAME })) as
      | { storedAt?: number }
      | undefined;
    return this.scanner.scan(
      tabId,
      typeof reply?.storedAt === 'number' ? { notBefore: reply.storedAt } : {},
    );
  }

  private async readSettings(): Promise<Settings> {
    const settings = await loadSettings();
    setDebugLogging(settings.advanced.debugLogging);
    return settings;
  }
}
