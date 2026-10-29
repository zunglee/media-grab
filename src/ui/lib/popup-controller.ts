/**
 * Everything the popup does apart from drawing itself. Popup.svelte renders
 * `PopupState` (plus a few display-only derivations: which row is best, how
 * many downloads are in flight) and forwards clicks to the methods here.
 *
 * Opening the popup (`start`):
 *
 *   subscribe to worker broadcasts   first, so a SCAN_RESULT or DOWNLOADS_STATE
 *                                    sent while the popup loads is not lost
 *   settings, download list          (independent of the tab)
 *   the active tab -> may MediaGrab read it? -> the tab's last scan
 *                                            -> none yet and allowed: scan now
 *
 * After that, each button is one method: grantAccess, rescan, download,
 * downloadBest, command, copyReport, openSettings.
 *
 * Plain TypeScript with a change callback rather than Svelte runes, so it runs,
 * and is unit-tested, in Node against a fake bridge.
 */

import type { DownloadTaskView } from '../../core/download-types.ts';
import type { DownloadCommand } from '../../core/messages.ts';
import type { MediaCandidate, MediaVariant, ScanResult } from '../../core/types.ts';
import { withoutFragment } from '../../media/fingerprint.ts';
import { pickBestDownload } from '../../media/quality.ts';
import { originPatternFor } from '../../permissions/site-access.ts';
import type { BackgroundMessage, PopupBridge, StartDownloadResult } from './bridge.ts';
import { buildReport, reportToJson } from './diagnostics.ts';

export type PopupView = 'media' | 'downloads';

/**
 * 'unknown' until the tab is known. 'unsupported' is a page no extension may
 * read (chrome://, about:, file:).
 */
export type SiteAccess = 'unknown' | 'unsupported' | 'needed' | 'granted';

/**
 * 'starting' while the popup opens, 'scanning' while a scan runs. 'idle' says
 * nothing is in flight, not that it went well: `tabId` and `scan` say that.
 */
export type ScanStatus = 'starting' | 'scanning' | 'idle';

export interface PopupState {
  view: PopupView;
  tabId: number | undefined;
  pageUrl: string;
  access: SiteAccess;
  scan: ScanResult | undefined;
  scanStatus: ScanStatus;
  downloads: DownloadTaskView[];
  /** A download is being started; the download buttons wait for it. */
  busy: boolean;
  powerMode: boolean;
  notice: string | null;
}

export const NOTICES = {
  reloadAfterGrant: 'Access granted. Reload the page so MediaGrab can see its media requests.',
  accessDeclined: 'MediaGrab was not given access to this site.',
  hostDeclined: 'MediaGrab was not given access to that server, so the download was not retried.',
  downloadNotStarted: 'The download could not be started.',
  audioNotStarted: 'The video is downloading, but its separate audio track could not be started.',
  reportCopied: 'A redacted diagnostic report is on your clipboard. Nothing was uploaded.',
  clipboardDenied: 'Could not access the clipboard.',
} as const;

const INITIAL_STATE: PopupState = {
  view: 'media',
  tabId: undefined,
  pageUrl: '',
  access: 'unknown',
  scan: undefined,
  scanStatus: 'starting',
  downloads: [],
  busy: false,
  powerMode: false,
  notice: null,
};

export class PopupController {
  private current: PopupState = INITIAL_STATE;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly bridge: PopupBridge,
    private readonly onChange: (state: PopupState) => void,
  ) {}

  get state(): PopupState {
    return this.current;
  }

  async start(): Promise<void> {
    this.unsubscribe = this.bridge.onBackgroundMessage((message) => this.receive(message));
    await Promise.all([this.loadMode(), this.refreshDownloads(), this.openTab()]);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  showView(view: PopupView): void {
    this.update({ view });
  }

  /**
   * Also the retry when the popup could not find its tab: "Scan again" is the
   * one button that state offers.
   */
  async rescan(): Promise<void> {
    const { tabId } = this.current;
    if (tabId === undefined) return this.openTab();
    this.update({ scanStatus: 'scanning', notice: null });
    // A failed scan needs no notice of its own: with no scan on screen, the
    // popup says the page could not be scanned and offers "Scan again".
    this.acceptScan(await this.bridge.requestScan(tabId).catch(() => undefined));
    this.update({ scanStatus: 'idle' });
  }

  /** Call straight from the click: the browser only prompts during the gesture. */
  async grantAccess(): Promise<void> {
    const { pageUrl } = this.current;
    if (!pageUrl) return;
    const granted = await this.bridge.requestSiteAccess(pageUrl);
    if (!granted) {
      this.update({ notice: NOTICES.accessDeclined });
      return;
    }
    this.update({ access: 'granted' });
    await this.rescan();
    // Set after the scan, which clears older notices: this one has to stay up
    // until the user has reloaded the page.
    this.update({ notice: NOTICES.reloadAfterGrant });
  }

  /**
   * One download, or two when the stream is split: `audio` is the separate
   * track a video-only rendition plays with (D20). It goes through the same
   * START_DOWNLOAD as a row's own audio button - the worker finds it among the
   * candidate's audio tracks - and is asked for only once the video has
   * started, so a refused video never leaves a lone audio file behind.
   */
  async download(
    candidate: MediaCandidate,
    variant?: MediaVariant,
    audio?: MediaVariant,
  ): Promise<void> {
    const { tabId } = this.current;
    if (tabId === undefined) return;
    this.update({ busy: true, notice: null });
    const result = await this.queue(tabId, candidate, variant);
    if (!result.ok) {
      this.update({ busy: false, notice: result.error ?? NOTICES.downloadNotStarted });
      return;
    }
    const sound = audio ? await this.queue(tabId, candidate, audio) : result;
    this.update({
      busy: false,
      view: 'downloads',
      ...(sound.ok ? {} : { notice: sound.error ?? NOTICES.audioNotStarted }),
    });
  }

  /**
   * The best of the page (media/quality.ts `pickBestDownload`), with its audio
   * when the stream is split. Does nothing when nothing can be saved.
   */
  async downloadBest(): Promise<void> {
    const best = pickBestDownload(this.current.scan?.candidates ?? []);
    if (best) await this.download(best.candidate, best.variant, best.audio);
  }

  async command(taskId: string, command: DownloadCommand): Promise<void> {
    await this.bridge.sendDownloadCommand(taskId, command);
    await this.refreshDownloads();
  }

  /**
   * "Allow ‹host› and retry" (D18): a host refused the download and MediaGrab
   * has no grant for it, so the page could not be named as Referer. Call
   * straight from the click: the browser only prompts during the gesture.
   */
  async allowHostAndRetry(taskId: string, host: string): Promise<void> {
    if (!(await this.bridge.requestHostAccess(host))) {
      this.update({ notice: NOTICES.hostDeclined });
      return;
    }
    await this.command(taskId, 'retry');
  }

  async copyReport(): Promise<void> {
    const { scan } = this.current;
    if (!scan) return;
    const report = buildReport(scan, this.bridge.extensionVersion(), navigator.userAgent);
    const copied = await this.bridge.copyToClipboard(reportToJson(report));
    this.update({ notice: copied ? NOTICES.reportCopied : NOTICES.clipboardDenied });
  }

  openSettings(): void {
    this.bridge.openOptions();
  }

  private async loadMode(): Promise<void> {
    try {
      const settings = await this.bridge.loadSettings();
      this.update({ powerMode: settings.general.mode === 'power' });
    } catch {
      // Simple mode is the default and needs no settings.
    }
  }

  private async refreshDownloads(): Promise<void> {
    this.update({ downloads: await this.bridge.getDownloads() });
  }

  private async openTab(): Promise<void> {
    const tab = await this.bridge.currentTab().catch(() => undefined);
    if (!tab) {
      this.update({ scanStatus: 'idle' });
      return;
    }
    const access = await this.accessTo(tab.url);
    this.update({ tabId: tab.id, pageUrl: tab.url, access });
    const stored = await this.bridge.getScan(tab.id).catch(() => undefined);
    // A scan of the page this tab showed before (the user has since moved to a
    // site MediaGrab cannot read) is not about the page on screen.
    if (stored && samePage(stored.pageUrl, tab.url)) this.acceptScan(stored);
    if (!this.current.scan && access === 'granted') await this.rescan();
    else this.update({ scanStatus: 'idle' });
  }

  private queue(
    tabId: number,
    candidate: MediaCandidate,
    variant: MediaVariant | undefined,
  ): Promise<StartDownloadResult> {
    return this.bridge
      .startDownload(tabId, candidate.id, variant?.id)
      .catch((): StartDownloadResult => ({ ok: false }));
  }

  private async accessTo(url: string): Promise<SiteAccess> {
    if (originPatternFor(url) === null) return 'unsupported';
    return (await this.bridge.hasSiteAccess(url)) ? 'granted' : 'needed';
  }

  private receive(message: BackgroundMessage): void {
    if (message.type === 'SCAN_RESULT' && message.result) {
      if (message.result.tabId === this.current.tabId) this.acceptScan(message.result);
    }
    if (message.type === 'DOWNLOADS_STATE' && message.tasks) {
      this.update({ downloads: message.tasks });
    }
  }

  /**
   * An older scan never replaces a newer one: the reply to GET_SCAN can arrive
   * after a SCAN_RESULT broadcast that was stored later.
   */
  private acceptScan(result: ScanResult | undefined): void {
    if (!result) return;
    const shown = this.current.scan;
    if (shown && result.scannedAt < shown.scannedAt) return;
    this.update({ scan: result });
  }

  private update(patch: Partial<PopupState>): void {
    this.current = { ...this.current, ...patch };
    this.onChange(this.current);
  }
}

/** Same document, whatever the fragment says. */
function samePage(a: string, b: string): boolean {
  return withoutFragment(a) === withoutFragment(b);
}
