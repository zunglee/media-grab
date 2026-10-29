/**
 * Manifest generation.
 *
 * The Chrome and Firefox manifests differ in four places (background shape,
 * offscreen permission, gecko settings, action key), so they are generated from
 * one source rather than maintained as two hand-edited JSON files that drift.
 *
 * Permission policy (PRD s43): NO host permissions at install time. The
 * extension asks per origin, from a click, with the reason on screen.
 */
/**
 * @typedef {'chrome' | 'firefox'} Target
 *
 * `test: true` produces a build for the automated extension tests only. It is
 * the shipping manifest plus two changes that cannot be scripted otherwise:
 * host permissions granted up front, and a declarative content script. Nothing
 * else differs, so a test still exercises the real background worker, the real
 * detection engine and the real download engine. It is never published.
 */

export const VERSION = '0.1.6';

/**
 * Name and description come from _locales/en/messages.json via __MSG_ lookups.
 * `default_locale` requires that subtree to exist - a manifest that declares a
 * default locale with no _locales/ directory is rejected at load time.
 */

/**
 * @param {Target} target
 * @param {{ test?: boolean }} [options]
 * @returns {Record<string, unknown>}
 */
export function buildManifest(target, options = {}) {
  // The test build stands in for "the user has already granted access", so it
  // keeps webRequest static - a scripted browser cannot answer a permission
  // prompt.
  const webRequestIsOptional = target === 'chrome' && options.test !== true;

  /** @type {Record<string, unknown>} */
  const manifest = {
    manifest_version: 3,
    name: '__MSG_extName__',
    version: VERSION,
    description: '__MSG_extDescription__',
    default_locale: 'en',

    icons: {
      16: 'assets/icon-16.png',
      32: 'assets/icon-32.png',
      48: 'assets/icon-48.png',
      128: 'assets/icon-128.png',
    },

    action: {
      default_title: '__MSG_actionTitle__',
      default_popup: 'popup.html',
      default_icon: {
        16: 'assets/icon-16.png',
        32: 'assets/icon-32.png',
      },
    },

    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },

    permissions: [
      'storage',
      'downloads',
      'tabs',
      'activeTab',
      'scripting',
      'contextMenus',
      'notifications',
      // `webRequest` is useless without a host permission, and declaring it with
      // none makes Chrome warn the user at install: "You need to request host
      // permissions in the manifest file in order to be notified about requests
      // from the webRequest API." So on Chrome it is optional and is requested
      // together with the origin, in the same click. Firefox keeps it static
      // because that build has never been run and this is not the change to
      // find that out with.
      ...(webRequestIsOptional ? [] : ['webRequest']),
      ...(target === 'chrome' ? ['offscreen'] : []),
      // The page as Referer on MediaGrab's own requests (ARCHITECTURE.md D18).
      // "WithHostAccess": rules only act on hosts the user has granted, and the
      // permission carries no install warning.
      'declarativeNetRequestWithHostAccess',
    ],
    optional_permissions: webRequestIsOptional ? ['webRequest'] : [],

    // Deliberately empty: nothing is granted until the user grants it.
    host_permissions: [],
    optional_host_permissions: ['*://*/*'],

    // No web_accessible_resources: the page hook is registered as a MAIN-world
    // content script (src/permissions/content-scripts.ts), not loaded by URL.
    // A web-accessible file is readable by every site, which is enough for any
    // page to detect that MediaGrab is installed.

    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+D' },
        description: '__MSG_commandOpen__',
      },
      'scan-page': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: '__MSG_commandScan__',
      },
      'download-best': {
        suggested_key: { default: 'Alt+Shift+A' },
        description: '__MSG_commandDownloadBest__',
      },
    },

    /**
     * No 'unsafe-eval', no remote script. The adapter registry is bundled, which
     * is the other half of the reason remote adapters are not implemented yet.
     */
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  };

  if (options.test) {
    manifest.name = 'MediaGrab (test build)';
    manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
    manifest.optional_host_permissions = ['*://*/*'];
    // The same two scripts the shipping build registers at run time.
    const matches = ['http://127.0.0.1/*', 'http://localhost/*'];
    manifest.content_scripts = [
      { matches, js: ['page-hook.js'], run_at: 'document_start', all_frames: true, world: 'MAIN' },
      { matches, js: ['content.js'], run_at: 'document_start', all_frames: true },
    ];
  }

  if (target === 'chrome') {
    manifest.background = { service_worker: 'background.js' };
    manifest.minimum_chrome_version = '116';
  } else {
    // Firefox MV3 runs an event page, not a service worker.
    manifest.background = { scripts: ['background.js'] };
    manifest.browser_specific_settings = {
      gecko: {
        id: 'mediagrab@local.invalid',
        strict_min_version: '128.0',
        // Required by addons.mozilla.org for new submissions. MediaGrab sends
        // nothing anywhere: no telemetry, no accounts (SECURITY.md).
        data_collection_permissions: { required: ['none'] },
      },
    };
  }

  return manifest;
}
