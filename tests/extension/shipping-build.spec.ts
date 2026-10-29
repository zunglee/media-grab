/**
 * The shipping build, loaded exactly as a user would load it: no host
 * permissions at all.
 *
 * This is the configuration `chrome-test` deliberately cannot cover, and it is
 * where the webRequest registration problem lives - `webRequest` listeners
 * require host permissions, and the extension has none until the user grants
 * one. The worker must survive that and still answer the popup.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, expect, test, type Worker } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const shippingPath = resolve(here, '../../dist/chrome');

let context: BrowserContext;
let worker: Worker;
let extensionId: string;
const workerLog: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'mediagrab-shipping-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${shippingPath}`, `--load-extension=${shippingPath}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  worker.on('console', (message) => workerLog.push(`[${message.type()}] ${message.text()}`));
  extensionId = new URL(worker.url()).host;
  // Give the worker a moment to finish booting and log.
  await new Promise((r) => setTimeout(r, 1500));
});

test.afterAll(async () => {
  await context?.close();
});

test('installs with no host permissions and no webRequest', async () => {
  const granted = await worker.evaluate(async () => {
    const all = await chrome.permissions.getAll();
    return { origins: all.origins ?? [], permissions: all.permissions ?? [] };
  });
  expect(granted.origins).toEqual([]);
  // `webRequest` with no host permission does nothing and makes Chrome warn the
  // user at install, so it is optional and comes with the first site grant.
  expect(granted.permissions).not.toContain('webRequest');
});

test('declares webRequest as optional, not static', async () => {
  const manifest = (await worker.evaluate(() => chrome.runtime.getManifest())) as {
    permissions?: string[];
    optional_permissions?: string[];
    host_permissions?: string[];
  };
  expect(manifest.permissions ?? []).not.toContain('webRequest');
  expect(manifest.optional_permissions ?? []).toContain('webRequest');
  expect(manifest.host_permissions ?? []).toEqual([]);
});

test('boots without throwing on the webRequest registration', async () => {
  const complaint = workerLog.find((line) => /host permissions/i.test(line));
  expect(complaint, `worker logged: ${workerLog.join(' | ')}`).toBeUndefined();
});

test('still answers the popup when it has no host permissions', async () => {
  // If boot() aborted, no message handler is registered and this hangs/returns
  // undefined - which is what a user would experience as "the popup is dead".
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const response = await page.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'GET_DOWNLOADS' }),
  );
  await page.close();

  expect(response, 'the background worker never registered its message handler').toBeTruthy();
  expect((response as { type: string }).type).toBe('DOWNLOADS_STATE');
});
