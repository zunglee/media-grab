/**
 * An in-memory BrowserApi: every method present, every call inert.
 *
 * The point of the browser abstraction is that nothing outside src/browser/
 * touches `chrome.*`; this is what that buys. The dev harness runs the options
 * page against it in an ordinary tab, and most unit tests of the worker and the
 * download manager start from it and override the few methods they exercise.
 */
import type { BrowserApi, StorageArea } from '../../browser/api.ts';

/**
 * Stores copies, as real browser storage does: a test that saved an object
 * and then changed it must not see the change when it reads it back, or a
 * lost write would go unnoticed.
 */
function memoryArea(): StorageArea {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      const value = map.get(key);
      return (value === undefined ? undefined : structuredClone(value)) as T | undefined;
    },
    async set(key, value) {
      map.set(key, structuredClone(value));
    },
    async remove(key) {
      map.delete(key);
    },
  };
}

export function createFakeBrowserApi(): BrowserApi {
  const noop = () => () => undefined;

  return {
    storage: { local: memoryArea(), session: memoryArea() },
    tabs: {
      async get() {
        return { id: 1, url: 'https://example.test/watch', title: 'Harness page' };
      },
      async query() {
        return [{ id: 1, url: 'https://example.test/watch', title: 'Harness page' }];
      },
      async sendMessage() {
        return undefined;
      },
      onRemoved: noop,
    },
    runtime: {
      async sendMessage() {
        return undefined;
      },
      async request() {
        return undefined;
      },
      onMessage: noop,
      getURL: (path) => `/${path}`,
      async openOptionsPage() {
        return undefined;
      },
      version: () => '0.0.0-harness',
      optionalApiPermissions: () => ['webRequest'],
      onInstalled: noop,
    },
    downloads: {
      async download() {
        return 1;
      },
      async cancel() {
        return undefined;
      },
      async pause() {
        return undefined;
      },
      async resume() {
        return undefined;
      },
      async search() {
        return undefined;
      },
      onChanged: noop,
    },
    action: {
      async setBadge() {
        return undefined;
      },
      async setTitle() {
        return undefined;
      },
    },
    webRequest: { isAvailable: () => true, onResponseStarted: noop },
    offscreen: {
      isSupported: () => false,
      async ensureDocument() {
        return undefined;
      },
      async close() {
        return undefined;
      },
    },
    headerRules: {
      isSupported: () => false,
      async setReferer() {
        return undefined;
      },
      async remove() {
        return undefined;
      },
      async ids() {
        return [];
      },
    },
    permissions: {
      async contains() {
        return true;
      },
      async request() {
        return true;
      },
      async getOrigins() {
        return ['https://example.test/*'];
      },
      onAdded: noop,
    },
    scripting: {
      async executeScript() {
        return undefined;
      },
      async registerContentScript() {
        return undefined;
      },
      async unregisterContentScript() {
        return undefined;
      },
      async registeredContentScripts() {
        return [];
      },
    },
    notifications: {
      async create() {
        return undefined;
      },
    },
    contextMenus: {
      create() {
        return undefined;
      },
      async removeAll() {
        return undefined;
      },
      onClicked: noop,
    },
    commands: { onCommand: noop },
  };
}
