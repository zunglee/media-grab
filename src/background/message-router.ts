/**
 * Every runtime message the worker accepts, one handler per type.
 *
 * Order of checks for each message:
 *   1. shape  - `parseMessage` drops anything malformed
 *   2. sender - a content script may only report on its page (PAGE_REPORT);
 *               everything that scans on demand, downloads or changes settings
 *               must come from one of our own extension pages
 *   3. handler
 *
 * The return value is the reply the sender's `sendMessage` resolves with.
 */
import type { MessageSender } from '../browser/api.ts';
import { browserApi } from '../browser/index.ts';
import { toMediaGrabError } from '../core/errors.ts';
import { createLogger } from '../core/log.ts';
import {
  acceptsFromContentScript,
  acceptsFromExtensionPage,
  type ExtensionMessage,
  parseMessage,
} from '../core/messages.ts';
import { candidateFromReport } from '../detection/candidate.ts';
import type { BackgroundServices } from './services.ts';
import { TOP_FRAME } from './tab-store.ts';

const log = createLogger('router');

/** Everything except the worker's own broadcasts. A missing handler is a compile error. */
type InboundType = Exclude<ExtensionMessage['type'], 'SCAN_RESULT' | 'DOWNLOADS_STATE'>;

type Handlers = {
  [T in InboundType]: (
    message: Extract<ExtensionMessage, { type: T }>,
    sender: MessageSender,
  ) => Promise<unknown>;
};

export function createMessageRouter(services: BackgroundServices) {
  const handlers: Handlers = {
    async PAGE_REPORT(report, sender) {
      const tabId = sender.tabId;
      if (tabId === undefined) return undefined;
      const frameId = sender.frameId ?? TOP_FRAME;

      // The page's claims, rebuilt by the worker: a page cannot hand us a
      // finished candidate with its own variants, score or DRM verdict.
      const origin = { pageUrl: report.pageUrl, pageTitle: report.pageTitle, frameId };
      const candidates = report.candidates.map((claim) => candidateFromReport(claim, origin));
      const { context, navigated } = await services.tabs.applyReport(tabId, frameId, {
        ...report,
        candidates,
      });
      const storedAt = performance.now();
      if (frameId === TOP_FRAME) {
        services.network.topFrameReported(tabId, {
          pageUrl: context.pageUrl,
          pageTitle: context.pageTitle,
          navigated,
          routeStartedAt: context.routeStartedAt,
        });
      }

      // Not awaited: the content script only needs to know its report is stored.
      void services
        .autoScan(tabId)
        .catch((err) => log.debug('auto scan failed', toMediaGrabError(err).message));
      return { stored: true, storedAt };
    },

    async REQUEST_SCAN(message) {
      const tabId = message.tabId ?? (await services.activeTabId());
      if (tabId === undefined) return undefined;
      return { type: 'SCAN_RESULT', result: await services.freshScan(tabId) };
    },

    async GET_SCAN(message) {
      const result = await services.tabs.lastScan(message.tabId);
      return result ? { type: 'SCAN_RESULT', result } : undefined;
    },

    async GET_DOWNLOADS() {
      return { type: 'DOWNLOADS_STATE', tasks: (await services.downloads()).list() };
    },

    async START_DOWNLOAD(message) {
      const scan = await services.tabs.lastScan(message.tabId);
      const candidate = scan?.candidates.find((entry) => entry.id === message.candidateId);
      if (!candidate) {
        return {
          ok: false,
          error: 'That media is no longer in the current scan. Scan the page again.',
        };
      }
      // A rendition, or one of the separate audio tracks the row also offers.
      const offered = [...(candidate.variants ?? []), ...(candidate.audioTracks ?? [])];
      const variant = message.variantId
        ? offered.find((entry) => entry.id === message.variantId)
        : undefined;
      // The quality the user picked is gone (a rescan changed the ladder).
      // Downloading "best" instead would be a silent substitution.
      if (message.variantId && !variant) {
        return {
          ok: false,
          error: 'That quality is no longer offered. Scan the page again.',
        };
      }
      try {
        return { ok: true, taskId: (await services.downloads()).enqueue(candidate, variant) };
      } catch (err) {
        const error = toMediaGrabError(err);
        return { ok: false, error: error.message, code: error.code };
      }
    },

    async DOWNLOAD_COMMAND(message) {
      return { ok: (await services.downloads()).command(message.taskId, message.command) };
    },

    async SETTINGS_CHANGED() {
      await services.reloadSettings();
      return undefined;
    },
  };

  return function route(raw: unknown, sender: MessageSender): Promise<unknown> | undefined {
    const message = parseMessage(raw);
    if (!message || !mayBeSentBy(message, sender)) return undefined;
    // mayBeSentBy admits inbound types only, so there is always a handler.
    const handler = handlers[message.type as InboundType] as (
      message: ExtensionMessage,
      sender: MessageSender,
    ) => Promise<unknown>;
    return handler(message, sender).catch((err) => {
      log.error(`${message.type} failed`, toMediaGrabError(err).message);
      return undefined;
    });
  };
}

/**
 * Content scripts run inside web pages; our own pages (popup, options) run at
 * the extension's origin. The sender URL, set by the browser, tells them apart.
 */
function mayBeSentBy(message: ExtensionMessage, sender: MessageSender): boolean {
  const fromExtensionPage = sender.url?.startsWith(browserApi().runtime.getURL('')) === true;
  return fromExtensionPage
    ? acceptsFromExtensionPage(message.type)
    : sender.tabId !== undefined && acceptsFromContentScript(message.type);
}
