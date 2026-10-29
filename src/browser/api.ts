/**
 * Browser abstraction (PRD s45). Every extension API call in this codebase goes
 * through `browserApi`; nothing outside src/browser/ may touch `chrome.*` or
 * `browser.*` directly. That is what keeps the Firefox and Chrome builds one
 * codebase, and it is also what makes the engine unit-testable in Node.
 */

export interface DownloadOptions {
  url: string;
  filename: string;
  saveAs?: boolean;
  /** What to do when a file of that name exists. Both browsers support it. */
  conflictAction?: 'uniquify' | 'overwrite' | 'prompt';
}

export interface StorageArea {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface TabInfo {
  id: number;
  url: string;
  title: string;
}

export interface DownloadItemInfo {
  id: number;
  state: 'in_progress' | 'interrupted' | 'complete';
  bytesReceived: number;
  /** -1 when the server did not send a Content-Length. */
  totalBytes: number;
  paused: boolean;
  error?: string;
}

/**
 * One `downloads.onChanged` event, reduced to what MediaGrab reads. Each field
 * is present only when it changed.
 *
 * Pausing differs by browser: Chrome keeps `state: 'in_progress'` and sets
 * `paused`; Firefox implements pause as an interruption, so a paused Firefox
 * download reads `state: 'interrupted'`, `error: 'USER_CANCELED'`,
 * `paused: true`. Only `paused` tells a pause from a cancel.
 */
export interface DownloadChange {
  id: number;
  state?: string;
  error?: string;
  paused?: boolean;
}

export interface BadgeState {
  text: string;
  color: string;
  tabId?: number;
}

export interface BrowserApi {
  storage: {
    local: StorageArea;
    session: StorageArea;
  };

  tabs: {
    get(tabId: number): Promise<TabInfo | undefined>;
    query(filter: { active?: boolean; currentWindow?: boolean }): Promise<TabInfo[]>;
    /**
     * Resolves with the first frame's reply, or undefined when no content script
     * is listening (chrome:// pages, the PDF viewer, an origin not granted yet).
     * Pass `frameId` to address one frame instead of all of them.
     */
    sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown>;
    /** Per-tab detection state has to be dropped when the tab goes away. */
    onRemoved(handler: (tabId: number) => void): () => void;
  };

  runtime: {
    /** Fire and forget: resolves undefined when nobody listens or the channel breaks. */
    sendMessage(message: unknown): Promise<unknown>;
    /**
     * A request that must be answered: rejects with the browser's reason when
     * no context received it or the receiver went away before replying.
     */
    request(message: unknown): Promise<unknown>;
    onMessage(
      // `void | Promise<unknown>` is the WebExtension contract: returning a
      // promise keeps the message channel open for an async reply, returning
      // nothing closes it immediately.
      // biome-ignore lint/suspicious/noConfusingVoidType: mirrors the platform API
      handler: (message: unknown, sender: MessageSender) => void | Promise<unknown>,
    ): () => void;
    getURL(path: string): string;
    /** Focuses an already-open options tab instead of opening a second one. */
    openOptionsPage(): Promise<void>;
    /** The version in manifest.json - the one the browser shows the user. */
    version(): string;
    /**
     * API permissions this build lists as optional. Chrome requests `webRequest`
     * with the first site; Firefox declares it up front, and asking Firefox for
     * a permission that is not in `optional_permissions` rejects the whole
     * request - site and all.
     */
    optionalApiPermissions(): string[];
    /**
     * Install and update. One-time set-up (context menus) belongs here: the
     * browser keeps it across worker restarts, so redoing it on every wake-up
     * is wasted work.
     */
    onInstalled(handler: () => void): () => void;
  };

  downloads: {
    /**
     * Resolves with the browser's id for the new download. Rejects with
     * CANCELLED when the user dismisses the Save As dialog (Firefox rejects;
     * Chrome resolves and reports the cancel through `onChanged`).
     */
    download(options: DownloadOptions): Promise<number>;
    cancel(id: number): Promise<void>;
    /**
     * The browser keeps the partial file, so a direct download can be paused and
     * resumed where it stopped. Segmented downloads cannot use these: their bytes
     * live in memory until they are handed over as one blob.
     */
    pause(id: number): Promise<void>;
    resume(id: number): Promise<void>;
    /**
     * Byte progress for a download the browser is doing on our behalf.
     * `downloads.onChanged` does not fire per byte, so a progress bar for a
     * direct file download has to poll for it.
     */
    search(id: number): Promise<DownloadItemInfo | undefined>;
    onChanged(handler: (change: DownloadChange) => void): () => void;
  };

  action: {
    setBadge(state: BadgeState): Promise<void>;
    setTitle(title: string, tabId?: number): Promise<void>;
  };

  webRequest: {
    /**
     * `webRequest` is an optional permission on Chrome: until the user grants a
     * site, the namespace does not exist and registering a listener would throw.
     */
    isAvailable(): boolean;
    /**
     * Observe-only. We never block or redirect, which is why the Chrome build
     * can stay on the non-blocking `webRequest` read APIs under MV3.
     */
    onResponseStarted(
      filter: { urls: string[] },
      handler: (details: WebRequestDetails) => void,
    ): () => void;
  };

  permissions: {
    contains(origins: string[], apiPermissions?: string[]): Promise<boolean>;
    /** Must be called from a user gesture. Asks for origins and APIs together. */
    request(origins: string[], apiPermissions?: string[]): Promise<boolean>;
    /** Origins the user has granted so far. */
    getOrigins(): Promise<string[]>;
    /** Fires when the user grants a new origin from the popup or options page. */
    onAdded(handler: (origins: string[]) => void): () => void;
  };

  scripting: {
    /**
     * Inject a bundled script file into a tab. Only ever used with our own
     * bundled files - never with a string of code, and never with anything
     * derived from page content.
     */
    executeScript(options: {
      tabId: number;
      files: string[];
      allFrames?: boolean;
      world?: ScriptWorld;
    }): Promise<void>;
    /**
     * Register the content script for the origins the user has granted, so it
     * runs at document_start on future navigations. This is what replaces a
     * declarative `content_scripts` block over <all_urls>.
     */
    registerContentScript(options: {
      id: string;
      matches: string[];
      files: string[];
      allFrames: boolean;
      runAt: 'document_start' | 'document_idle';
      world?: ScriptWorld;
    }): Promise<void>;
    unregisterContentScript(id: string): Promise<void>;
    /** What is registered now, so an unchanged registration can be left alone. */
    registeredContentScripts(): Promise<Array<{ id: string; matches: string[] }>>;
  };

  /**
   * Chrome only. An MV3 service worker has no `URL.createObjectURL`, so segment
   * assembly runs in an offscreen document (ARCHITECTURE.md D4). Firefox's
   * background has a DOM and never needs one.
   */
  offscreen: {
    isSupported(): boolean;
    /** Create the document if it does not exist yet. Safe to call concurrently. */
    ensureDocument(path: string, justification: string): Promise<void>;
    /**
     * Close the document if it exists. Every blob URL it created dies with it,
     * so only call this when no download is being assembled or written from it.
     */
    close(): Promise<void>;
  };

  /**
   * Session-scoped request header rules (`declarativeNetRequest`). Used for one
   * thing: setting `Referer` on requests MediaGrab itself makes, where the user
   * has granted host access (ARCHITECTURE.md D18). The browser applies a rule
   * only to hosts the extension may access, and drops session rules when the
   * browser or the extension restarts.
   */
  headerRules: {
    isSupported(): boolean;
    /** Replace (or add) the rule with this id. */
    setReferer(rule: { id: number; host: string; referer: string }): Promise<void>;
    remove(ids: number[]): Promise<void>;
    /** Ids of every session rule this extension currently has. */
    ids(): Promise<number[]>;
  };

  notifications: {
    create(
      id: string,
      options: { title: string; message: string; iconUrl?: string },
    ): Promise<void>;
  };

  contextMenus: {
    create(item: ContextMenuItem): void;
    removeAll(): Promise<void>;
    /** `srcUrl` is the media element the user right-clicked, when there was one. */
    onClicked(
      handler: (info: { menuItemId: string; srcUrl?: string }, tab?: TabInfo) => void,
    ): () => void;
  };

  commands: {
    onCommand(handler: (command: string, tab?: TabInfo) => void): () => void;
  };
}

/**
 * ISOLATED is the content script's own world: shared DOM, private JavaScript.
 * MAIN is the page's world, where the page hook must run to see the page's own
 * `fetch`, `MediaSource` and `MediaKeys` calls (Chrome 102+, Firefox 128+).
 */
export type ScriptWorld = 'ISOLATED' | 'MAIN';

export interface ContextMenuItem {
  id: string;
  title: string;
  contexts: Array<'page' | 'video' | 'audio' | 'image' | 'link' | 'selection'>;
  parentId?: string;
}

export interface MessageSender {
  tabId?: number;
  frameId?: number;
  url?: string;
  origin?: string;
}

export interface WebRequestDetails {
  url: string;
  tabId: number;
  frameId: number;
  method: string;
  type: string;
  statusCode: number;
  timeStamp: number;
  responseHeaders?: Array<{ name: string; value?: string }>;
  initiator?: string;
  /** Chrome 106+: 'prerender' for a page loaded ahead of a navigation the user has not made yet. */
  documentLifecycle?: string;
}
