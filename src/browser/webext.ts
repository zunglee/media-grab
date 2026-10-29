/**
 * The one place that touches the raw WebExtension namespace.
 *
 * Chrome (MV3) and Firefox (MV3) differ in three ways that matter to us:
 *  1. Firefox exposes `browser.*` with promises; Chrome exposes `chrome.*` with
 *     callbacks, plus promise support on most MV3 APIs. We normalize to promises.
 *  2. Firefox has no `chrome.storage.session` before 115 (an in-memory map
 *     stands in) and no offscreen documents (it never needs one).
 *  3. Firefox's background is an event page (`background.scripts`), Chrome's is a
 *     service worker. Neither can hold long-lived state, so nothing here does.
 */
import { ErrorCode, MediaGrabError } from '../core/errors.ts';
import type {
  BadgeState,
  BrowserApi,
  ContextMenuItem,
  DownloadOptions,
  MessageSender,
  StorageArea,
  TabInfo,
  WebRequestDetails,
} from './api.ts';

type AnyNamespace = typeof chrome;

declare const browser: AnyNamespace | undefined;

function ns(): AnyNamespace {
  // The `typeof` guards are load-bearing: `browser` is undeclared in Chrome and
  // `chrome` is undeclared in some Firefox contexts, so an optional chain alone
  // would throw a ReferenceError rather than returning undefined.
  // biome-ignore lint/complexity/useOptionalChain: typeof guard is required, see above
  if (typeof browser !== 'undefined' && browser?.runtime?.id) return browser;
  if (typeof chrome !== 'undefined' && chrome?.runtime?.id) return chrome;
  throw new Error('No WebExtension namespace available');
}

/** Wrap a callback-style API when the promise form is missing (older Chrome paths). */
function promisify<T>(fn: (cb: (value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      fn((value) => {
        const err = ns().runtime.lastError;
        if (err) reject(new Error(err.message ?? 'runtime error'));
        else resolve(value);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function makeStorageArea(
  area: chrome.storage.StorageArea | undefined,
  fallback: Map<string, unknown>,
): StorageArea {
  if (!area) {
    // storage.session is absent on older Firefox; an in-memory map has the same
    // lifetime semantics (cleared when the background context is torn down).
    return {
      async get<T>(key: string) {
        return fallback.get(key) as T | undefined;
      },
      async set(key, value) {
        fallback.set(key, value);
      },
      async remove(key) {
        fallback.delete(key);
      },
    };
  }
  return {
    async get<T>(key: string) {
      const result = (await area.get(key)) as Record<string, unknown>;
      return result[key] as T | undefined;
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async remove(key) {
      await area.remove(key);
    },
  };
}

function toTabInfo(tab: chrome.tabs.Tab | undefined): TabInfo | undefined {
  if (!tab || tab.id === undefined) return undefined;
  return { id: tab.id, url: tab.url ?? '', title: tab.title ?? '' };
}

const sessionFallback = new Map<string, unknown>();

/** One offscreen document creation at a time; see `offscreen.ensureDocument`. */
let offscreenCreation: Promise<void> | null = null;
/**
 * A close in progress. Creation waits for it, so a download that starts while
 * the document is closing gets a new document instead of one about to vanish.
 */
let offscreenClosing: Promise<void> | null = null;

/**
 * The typings model API permissions as a closed union of manifest permissions.
 * Ours come from a plain string list (the manifest's optional permissions,
 * permissions/site-access.ts), so the cast is here, once, rather than at every
 * call site.
 */
function toPermissions(
  origins: string[],
  apiPermissions?: string[],
): chrome.permissions.Permissions {
  return {
    origins,
    ...(apiPermissions
      ? { permissions: apiPermissions as chrome.runtime.ManifestPermissions[] }
      : {}),
  };
}

export function createWebExtApi(): BrowserApi {
  const api = ns();

  return {
    storage: {
      local: makeStorageArea(api.storage?.local, new Map()),
      session: makeStorageArea(api.storage?.session, sessionFallback),
    },

    tabs: {
      async get(tabId) {
        try {
          return toTabInfo(await api.tabs.get(tabId));
        } catch {
          return undefined;
        }
      },
      async query(filter) {
        const tabs = await api.tabs.query(filter);
        return tabs.map(toTabInfo).filter((t): t is TabInfo => t !== undefined);
      },
      async sendMessage(tabId, message, options) {
        try {
          return options?.frameId !== undefined
            ? await api.tabs.sendMessage(tabId, message, { frameId: options.frameId })
            : await api.tabs.sendMessage(tabId, message);
        } catch {
          // No content script in that tab (chrome:// page, PDF viewer, ...).
          return undefined;
        }
      },
      onRemoved(handler) {
        const listener = (tabId: number) => handler(tabId);
        api.tabs.onRemoved.addListener(listener);
        return () => api.tabs.onRemoved.removeListener(listener);
      },
    },

    runtime: {
      async sendMessage(message) {
        try {
          return await api.runtime.sendMessage(message);
        } catch {
          return undefined;
        }
      },
      async request(message) {
        return api.runtime.sendMessage(message);
      },
      onMessage(handler) {
        const listener = (
          message: unknown,
          sender: chrome.runtime.MessageSender,
          sendResponse: (response?: unknown) => void,
        ): boolean => {
          const normalized: MessageSender = {
            ...(sender.tab?.id !== undefined ? { tabId: sender.tab.id } : {}),
            ...(sender.frameId !== undefined ? { frameId: sender.frameId } : {}),
            ...(sender.url !== undefined ? { url: sender.url } : {}),
            ...(sender.origin !== undefined ? { origin: sender.origin } : {}),
          };
          const result = handler(message, normalized);
          if (result instanceof Promise) {
            result.then(sendResponse).catch(() => sendResponse(undefined));
            return true; // keep the channel open for the async reply
          }
          return false;
        };
        api.runtime.onMessage.addListener(listener);
        return () => api.runtime.onMessage.removeListener(listener);
      },
      getURL(path) {
        return api.runtime.getURL(path);
      },
      async openOptionsPage() {
        await api.runtime.openOptionsPage();
      },
      version() {
        return api.runtime.getManifest().version;
      },
      optionalApiPermissions() {
        const optional = api.runtime.getManifest().optional_permissions ?? [];
        return optional.map(String);
      },
      onInstalled(handler) {
        const listener = () => handler();
        api.runtime.onInstalled.addListener(listener);
        return () => api.runtime.onInstalled.removeListener(listener);
      },
    },

    downloads: {
      async download(options: DownloadOptions) {
        const request: chrome.downloads.DownloadOptions = {
          url: options.url,
          filename: options.filename,
          saveAs: options.saveAs === true,
        };
        if (options.conflictAction) {
          request.conflictAction = options.conflictAction;
        }
        let id: number | undefined;
        try {
          id = await api.downloads.download(request);
        } catch (err) {
          // Firefox rejects when the user closes the Save As dialog. That is a
          // choice, not a failure: no error, no Retry button.
          const message = err instanceof Error ? err.message : String(err);
          if (/cancel/i.test(message)) {
            throw new MediaGrabError(ErrorCode.CANCELLED, 'The save was cancelled.');
          }
          throw err;
        }
        if (typeof id !== 'number') throw new Error('download() returned no id');
        return id;
      },
      async cancel(id) {
        await api.downloads.cancel(id);
      },
      async pause(id) {
        await api.downloads.pause(id);
      },
      async resume(id) {
        await api.downloads.resume(id);
      },
      async search(id) {
        const [item] = await api.downloads.search({ id });
        if (!item) return undefined;
        return {
          id: item.id,
          state: item.state as 'in_progress' | 'interrupted' | 'complete',
          bytesReceived: item.bytesReceived,
          totalBytes: item.totalBytes,
          paused: item.paused === true,
          ...(item.error ? { error: item.error } : {}),
        };
      },
      onChanged(handler) {
        const listener = (delta: chrome.downloads.DownloadDelta) => {
          handler({
            id: delta.id,
            ...(delta.state?.current ? { state: delta.state.current } : {}),
            ...(delta.error?.current ? { error: delta.error.current } : {}),
            ...(delta.paused ? { paused: delta.paused.current === true } : {}),
          });
        };
        api.downloads.onChanged.addListener(listener);
        return () => api.downloads.onChanged.removeListener(listener);
      },
    },

    action: {
      async setBadge(state: BadgeState) {
        const tabPart = state.tabId !== undefined ? { tabId: state.tabId } : {};
        await api.action.setBadgeText({ text: state.text, ...tabPart });
        await api.action.setBadgeBackgroundColor({ color: state.color, ...tabPart });
      },
      async setTitle(title, tabId) {
        await api.action.setTitle({ title, ...(tabId !== undefined ? { tabId } : {}) });
      },
    },

    webRequest: {
      isAvailable() {
        return typeof api.webRequest?.onResponseStarted?.addListener === 'function';
      },
      onResponseStarted(filter, handler) {
        const listener = (details: chrome.webRequest.OnResponseStartedDetails) => {
          handler(details as unknown as WebRequestDetails);
        };
        api.webRequest.onResponseStarted.addListener(listener, filter, ['responseHeaders']);
        return () => api.webRequest.onResponseStarted.removeListener(listener);
      },
    },

    permissions: {
      async contains(origins, apiPermissions) {
        return api.permissions.contains(toPermissions(origins, apiPermissions));
      },
      async request(origins, apiPermissions) {
        return api.permissions.request(toPermissions(origins, apiPermissions));
      },
      async getOrigins() {
        const all = await api.permissions.getAll();
        return all.origins ?? [];
      },
      onAdded(handler) {
        const listener = (permissions: chrome.permissions.Permissions) =>
          handler(permissions.origins ?? []);
        api.permissions.onAdded.addListener(listener);
        return () => api.permissions.onAdded.removeListener(listener);
      },
    },

    scripting: {
      async executeScript(options) {
        await api.scripting.executeScript({
          target: { tabId: options.tabId, allFrames: options.allFrames === true },
          files: options.files,
          ...(options.world ? { world: options.world } : {}),
        });
      },
      async registerContentScript(options) {
        await api.scripting.registerContentScripts([
          {
            id: options.id,
            matches: options.matches,
            js: options.files,
            allFrames: options.allFrames,
            runAt: options.runAt,
            ...(options.world ? { world: options.world } : {}),
          },
        ]);
      },
      async unregisterContentScript(id) {
        await api.scripting.unregisterContentScripts({ ids: [id] });
      },
      async registeredContentScripts() {
        const registered = await api.scripting.getRegisteredContentScripts();
        return registered.map((script) => ({ id: script.id, matches: script.matches ?? [] }));
      },
    },

    offscreen: {
      isSupported() {
        return typeof api.offscreen?.createDocument === 'function';
      },
      async ensureDocument(path, justification) {
        await offscreenClosing;
        // A creation in flight lists the document before its script listens
        // (getContexts sees it at once). Returning then would send work to a
        // page with no listener yet: "Receiving end does not exist". Wait for it.
        await offscreenCreation;
        const url = api.runtime.getURL(path);
        const existing = await api.runtime
          .getContexts?.({
            contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
            documentUrls: [url],
          })
          .catch(() => undefined);
        if (existing && existing.length > 0) return;

        // createDocument throws while another creation is in flight; share it.
        offscreenCreation ??= api.offscreen
          .createDocument({
            url: path,
            reasons: ['BLOBS' as chrome.offscreen.Reason],
            justification,
          })
          .catch((err: unknown) => {
            // "Only a single offscreen document may be created" means we lost a
            // benign race with ourselves: the document exists, which is the goal.
            const message = err instanceof Error ? err.message : String(err);
            if (!/single offscreen document/i.test(message)) throw err;
          })
          .finally(() => {
            offscreenCreation = null;
          });
        await offscreenCreation;
      },
      async close() {
        if (typeof api.offscreen?.closeDocument !== 'function') return;
        // Registered before the first await, so an `ensureDocument` that starts
        // a moment later always waits for this close and then creates afresh.
        offscreenClosing ??= (async () => {
          await offscreenCreation; // never close a document mid-creation
          // Rejects when there is no document to close, which is the goal anyway.
          await api.offscreen.closeDocument().catch(() => undefined);
        })().finally(() => {
          offscreenClosing = null;
        });
        await offscreenClosing;
      },
    },

    headerRules: {
      isSupported() {
        return typeof api.declarativeNetRequest?.updateSessionRules === 'function';
      },
      async setReferer({ id, host, referer }) {
        await api.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [id],
          addRules: [
            {
              id,
              priority: 1,
              action: {
                type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
                requestHeaders: [
                  {
                    header: 'referer',
                    operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
                    value: referer,
                  },
                ],
              },
              condition: {
                requestDomains: [host],
                // TAB_ID_NONE: only requests no tab made - ours, never the page's.
                tabIds: [-1],
                resourceTypes: [
                  'xmlhttprequest',
                  'media',
                  'other',
                ] as chrome.declarativeNetRequest.ResourceType[],
              },
            },
          ],
        });
      },
      async remove(ids) {
        if (ids.length === 0) return;
        await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
      },
      async ids() {
        const rules = await api.declarativeNetRequest.getSessionRules();
        return rules.map((rule) => rule.id);
      },
    },

    notifications: {
      async create(id, options) {
        await promisify<string>((cb) =>
          api.notifications.create(
            id,
            {
              type: 'basic',
              title: options.title,
              message: options.message,
              iconUrl: options.iconUrl ?? api.runtime.getURL('assets/icon-128.png'),
            },
            cb,
          ),
        );
      },
    },

    contextMenus: {
      create(item: ContextMenuItem) {
        api.contextMenus.create({
          id: item.id,
          title: item.title,
          // The typings want a non-empty tuple; our ContextMenuItem already
          // guarantees at least one context.
          contexts: item.contexts as [
            chrome.contextMenus.ContextType,
            ...chrome.contextMenus.ContextType[],
          ],
          ...(item.parentId ? { parentId: item.parentId } : {}),
        });
      },
      async removeAll() {
        await promisify<void>((cb) => api.contextMenus.removeAll(cb));
      },
      onClicked(handler) {
        const listener = (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => {
          handler(
            {
              menuItemId: String(info.menuItemId),
              ...(info.srcUrl ? { srcUrl: info.srcUrl } : {}),
            },
            toTabInfo(tab),
          );
        };
        api.contextMenus.onClicked.addListener(listener);
        return () => api.contextMenus.onClicked.removeListener(listener);
      },
    },

    commands: {
      onCommand(handler) {
        const listener = (command: string, tab?: chrome.tabs.Tab) =>
          handler(command, toTabInfo(tab));
        api.commands.onCommand.addListener(listener);
        return () => api.commands.onCommand.removeListener(listener);
      },
    },
  };
}
