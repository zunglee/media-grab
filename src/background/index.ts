/**
 * Background entry point: builds the worker's services and connects them to
 * browser events. Chrome runs this as an MV3 service worker; Firefox runs the
 * same bundle as an event page. Neither may hold long-lived state, so anything
 * that must survive a restart lives in storage.session (per-tab detection) or
 * storage.local (settings, history).
 *
 * Where each flow continues:
 *
 *   page loads -> content script PAGE_REPORT -> message-router -> TabStore
 *                                                   `-> Scanner (if auto-scan)
 *   media request seen -> NetworkObserver -> Scanner (if auto-scan)
 *   popup "Scan again" -> REQUEST_SCAN -> fresh report from the page -> Scanner
 *   popup "Download"   -> START_DOWNLOAD -> DownloadManager -> engines
 *   browser finishes a file -> downloads.onChanged -> DownloadManager
 *                                                   `-> download-hooks (history)
 *
 * Every listener is registered synchronously at start-up, as MV3 requires, and
 * every handler catches its own errors: one failing listener must not stop the
 * worker from answering the popup.
 */
import { browserApi } from '../browser/index.ts';
import { toMediaGrabError } from '../core/errors.ts';
import { createLogger } from '../core/log.ts';
import {
  grantedMatchPatterns,
  syncContentScriptRegistration,
} from '../permissions/content-scripts.ts';
import { installContextMenus, MENU_IDS } from './context-menus.ts';
import { createMessageRouter } from './message-router.ts';
import { BackgroundServices } from './services.ts';

const log = createLogger('background');

/** Run an event handler without letting its failure escape the listener. */
function safely(label: string, work: () => Promise<unknown>): void {
  void work().catch((err) => log.warn(`${label} failed`, toMediaGrabError(err).message));
}

function boot(): void {
  const api = browserApi();
  const services = new BackgroundServices();

  // Popup, options page and content scripts.
  api.runtime.onMessage(createMessageRouter(services));

  // Both the content script and the network observer are scoped to the origins
  // the user has granted, so both are re-wired whenever that set changes.
  const syncGrantedOrigins = async (): Promise<void> => {
    await syncContentScriptRegistration();
    services.network.start(await grantedMatchPatterns());
  };
  safely('syncing granted origins', syncGrantedOrigins);
  api.permissions.onAdded(() => safely('syncing granted origins', syncGrantedOrigins));

  services.network.onCandidate((tabId) => safely('auto scan', () => services.autoScan(tabId)));

  api.tabs.onRemoved((tabId) => {
    services.network.forgetTab(tabId);
    safely('forgetting a closed tab', () => services.tabs.forget(tabId));
  });

  api.downloads.onChanged((change) =>
    safely('download update', async () => {
      await (await services.downloadsIfNeeded())?.handleBrowserDownloadChanged(change);
    }),
  );

  // A new worker takes charge of what the last one left (D16): queued tasks
  // resume, finished files reach history, the rest say they were interrupted.
  safely('taking charge of saved downloads', () => services.downloadsIfNeeded());

  // Keyboard shortcuts and the right-click menu offer the same two actions.
  // `srcUrl` is the <video>/<audio> the user right-clicked, when they did.
  const runAction = async (
    action: 'scan' | 'download-best',
    tabId: number | undefined,
    srcUrl?: string,
  ): Promise<void> => {
    const target = tabId ?? (await services.activeTabId());
    if (target === undefined) return;
    if (action === 'scan') await services.scanner.scan(target);
    else await services.downloadBest(target, srcUrl);
  };

  api.commands.onCommand((command, tab) => {
    if (command === 'scan-page') safely('shortcut', () => runAction('scan', tab?.id));
    if (command === 'download-best') safely('shortcut', () => runAction('download-best', tab?.id));
  });

  // The browser keeps menu items across worker restarts; build them once.
  api.runtime.onInstalled(() => safely('installing context menus', installContextMenus));
  api.contextMenus.onClicked((info, tab) => {
    if (info.menuItemId === MENU_IDS.scan) safely('menu', () => runAction('scan', tab?.id));
    if (info.menuItemId === MENU_IDS.downloadBest) {
      safely('menu', () => runAction('download-best', tab?.id, info.srcUrl));
    }
  });

  log.info('MediaGrab background ready');
}

boot();
