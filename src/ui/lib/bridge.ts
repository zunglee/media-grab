/**
 * The popup's door to everything outside it: the background worker, the
 * browser, settings storage and the clipboard. Components never call
 * `browserApi()` themselves; the options page uses the few helpers below and
 * the storage and permission modules directly.
 *
 * The popup receives its door as a `PopupBridge` rather than importing one, so
 * the same popup logic runs against the real extension, the dev harness's
 * fixtures and the unit tests' fakes:
 *
 *   popup/main.ts      extensionBridge  -> PopupController -> Popup.svelte
 *   harness            fixture bridge   -> PopupController -> Popup.svelte
 *   tests/unit         fake bridge      -> PopupController
 */
import { browserApi, type TabInfo } from '../../browser/index.ts';
import type { DownloadTaskView } from '../../core/download-types.ts';
import type { DownloadCommand } from '../../core/messages.ts';
import type { ScanResult } from '../../core/types.ts';
import {
  hasSiteAccess,
  requestHostAccess,
  requestSiteAccess,
} from '../../permissions/site-access.ts';
import { loadSettings, type Settings } from '../../storage/settings.ts';
import { copyToClipboard } from './diagnostics.ts';

/** What the worker broadcasts to open popups: SCAN_RESULT and DOWNLOADS_STATE. */
export interface BackgroundMessage {
  type: string;
  result?: ScanResult;
  tasks?: DownloadTaskView[];
}

export interface StartDownloadResult {
  ok: boolean;
  taskId?: string;
  error?: string;
  code?: string;
}

export interface PopupBridge {
  /** The tab the popup was opened over. */
  currentTab(): Promise<TabInfo | undefined>;
  /** The worker's last scan of a tab, without scanning again. */
  getScan(tabId: number): Promise<ScanResult | undefined>;
  /** A fresh scan. Undefined when the worker did not answer. */
  requestScan(tabId: number): Promise<ScanResult | undefined>;
  getDownloads(): Promise<DownloadTaskView[]>;
  startDownload(
    tabId: number,
    candidateId: string,
    variantId?: string,
  ): Promise<StartDownloadResult>;
  sendDownloadCommand(taskId: string, command: DownloadCommand): Promise<void>;
  /** Returns the unsubscribe function. */
  onBackgroundMessage(handler: (message: BackgroundMessage) => void): () => void;
  loadSettings(): Promise<Settings>;
  hasSiteAccess(url: string): Promise<boolean>;
  /** Must be reached from the click itself, with no `await` before it. */
  requestSiteAccess(url: string): Promise<boolean>;
  /** "Allow ‹host› and retry" on a failed download. Same gesture rule. */
  requestHostAccess(host: string): Promise<boolean>;
  /** The manifest version, as the browser shows it. */
  extensionVersion(): string;
  copyToClipboard(text: string): Promise<boolean>;
  openOptions(): void;
}

export const extensionBridge: PopupBridge = {
  async currentTab() {
    try {
      const [tab] = await browserApi().tabs.query({ active: true, currentWindow: true });
      return tab;
    } catch {
      return undefined;
    }
  },

  async getScan(tabId) {
    const response = (await browserApi().runtime.sendMessage({ type: 'GET_SCAN', tabId })) as
      | { type: 'SCAN_RESULT'; result: ScanResult }
      | undefined;
    return response?.result;
  },

  async requestScan(tabId) {
    const response = (await browserApi().runtime.sendMessage({ type: 'REQUEST_SCAN', tabId })) as
      | { type: 'SCAN_RESULT'; result: ScanResult }
      | undefined;
    return response?.result;
  },

  async getDownloads() {
    const response = (await browserApi().runtime.sendMessage({ type: 'GET_DOWNLOADS' })) as
      | { type: 'DOWNLOADS_STATE'; tasks: DownloadTaskView[] }
      | undefined;
    return response?.tasks ?? [];
  },

  async startDownload(tabId, candidateId, variantId) {
    const response = (await browserApi().runtime.sendMessage({
      type: 'START_DOWNLOAD',
      tabId,
      candidateId,
      ...(variantId ? { variantId } : {}),
    })) as StartDownloadResult | undefined;
    return response ?? { ok: false, error: 'MediaGrab did not respond.' };
  },

  async sendDownloadCommand(taskId, command) {
    await browserApi().runtime.sendMessage({ type: 'DOWNLOAD_COMMAND', taskId, command });
  },

  onBackgroundMessage(handler) {
    return browserApi().runtime.onMessage((raw) => {
      if (
        typeof raw === 'object' &&
        raw !== null &&
        typeof (raw as BackgroundMessage).type === 'string'
      ) {
        handler(raw as BackgroundMessage);
      }
      return undefined;
    });
  },

  loadSettings,
  hasSiteAccess,
  requestSiteAccess,
  requestHostAccess,

  extensionVersion() {
    return browserApi().runtime.version();
  },

  copyToClipboard,

  /**
   * `runtime.openOptionsPage` focuses an options tab that is already open
   * instead of stacking up new ones, and it honours the `options_ui` declaration.
   */
  openOptions() {
    void browserApi().runtime.openOptionsPage();
  },
};

/** Tells the worker to reload settings after the options page saved them. */
export async function notifySettingsChanged(): Promise<void> {
  await browserApi().runtime.sendMessage({ type: 'SETTINGS_CHANGED' });
}
