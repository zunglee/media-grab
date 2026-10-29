/**
 * D17 in a real Chromium: single-page apps whose routes change by hash and by
 * the Navigation API (fixture-site.ts `D17_PAGES`).
 *
 * Each route's player fetches its own manifest from the fixture's second host,
 * which the test build holds no grant for, so the network observer never sees
 * it: only the page hook and Resource Timing do - the two detectors that must
 * know which route a request belongs to. Everything is asserted through the
 * scan the worker stores for the tab, read from an extension page.
 *
 * tests/unit/navigation.test.ts checks the same rules against the order the
 * HTML standard gives the events; this is where Chromium's own order is met.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test';
import { type FixtureSite, startFixtureSite } from './fixture-site.ts';

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, '../../dist/chrome-test');

let site: FixtureSite;
let context: BrowserContext;
/** An extension page, kept open: it reads the worker's state and talks to it like the popup. */
let extensionPage: Page;
const opened: Page[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  site = await startFixtureSite();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mediagrab-navigation-'));
  mkdirSync(join(userDataDir, 'Default'), { recursive: true });
  writeFileSync(join(userDataDir, 'Default', 'Preferences'), JSON.stringify({}));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
});

test.afterEach(async () => {
  // Closed, so the next test's tab is the only one at its address.
  for (const page of opened.splice(0)) await page.close().catch(() => undefined);
});

test.afterAll(async () => {
  await context?.close();
  await site?.close();
});

interface ScanShape {
  pageUrl: string;
  candidates: Array<{ url: string }>;
}

async function storedScan(tabId: number): Promise<ScanShape | null> {
  return (await extensionPage.evaluate(async (id) => {
    const key = `scan:${id}`;
    const stored = await chrome.storage.session.get(key);
    return stored[key] ?? null;
  }, tabId)) as ScanShape | null;
}

/** The stored scan, once detection has settled into what `predicate` expects. */
async function waitForScan(
  tabId: number,
  predicate: (scan: ScanShape) => boolean,
  timeoutMs = 20_000,
): Promise<ScanShape> {
  const deadline = Date.now() + timeoutMs;
  let last: ScanShape | null = null;
  while (Date.now() < deadline) {
    last = await storedScan(tabId);
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`scan never satisfied the predicate. Last value: ${JSON.stringify(last)}`);
}

/** "Scan again", as the popup asks for it. */
async function scanAgain(tabId: number): Promise<ScanShape> {
  const reply = (await extensionPage.evaluate((message) => chrome.runtime.sendMessage(message), {
    type: 'REQUEST_SCAN',
    tabId,
  })) as { result: ScanShape };
  return reply.result;
}

async function openApp(path: string): Promise<{ page: Page; tabId: number }> {
  const page = await context.newPage();
  opened.push(page);
  await page.goto(`${site.origin}${path}`);
  await page.waitForLoadState('networkidle');
  // The app may already have moved its address on (a hash route): match the start.
  const tabId = (await extensionPage.evaluate(async (prefix) => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => tab.url?.startsWith(prefix)).at(-1)?.id ?? -1;
  }, `${site.origin}${path}`)) as number;
  expect(tabId).toBeGreaterThan(0);
  return { page, tabId };
}

const lists = (scan: ScanShape, manifest: string) =>
  scan.candidates.some((candidate) => candidate.url.endsWith(`/cdn/route/${manifest}.m3u8`));

/** Long enough for the content script's late pass after a route change (2.5 s) to report. */
const settle = () => new Promise((r) => setTimeout(r, 3_500));

// ─── Hash routes ─────────────────────────────────────────────────────────────

test("D17: a new hash route replaces the old route's media", async () => {
  const { page, tabId } = await openApp('/hash');
  await waitForScan(tabId, (scan) => lists(scan, 'hash-one'));

  await page.click('#to-video-2');
  const onRouteTwo = (scan: ScanShape) =>
    scan.pageUrl.endsWith('#/video/2') && lists(scan, 'hash-two');
  const scan = await waitForScan(tabId, onRouteTwo);
  expect(lists(scan, 'hash-one'), 'the old route media was kept').toBe(false);

  await settle();
  const settled = await waitForScan(tabId, onRouteTwo, 5_000);
  expect(lists(settled, 'hash-one'), 'the old route media came back').toBe(false);
});

test('D17: a hashbang route is a new route too', async () => {
  const { page, tabId } = await openApp('/hash');
  await waitForScan(tabId, (scan) => lists(scan, 'hash-one'));

  await page.click('#to-video-3');
  const scan = await waitForScan(
    tabId,
    (s) => s.pageUrl.endsWith('#!/video/3') && lists(s, 'hash-three'),
  );
  expect(lists(scan, 'hash-one'), 'the old route media was kept').toBe(false);
});

test("D17: #anchor clicks on a hash-routed page keep the route's media", async () => {
  const { page, tabId } = await openApp('/hash');
  await waitForScan(tabId, (scan) => lists(scan, 'hash-one'));

  // An in-page anchor, then a media fragment. The router leaves both alone and
  // fetches nothing: if either counted as a new route, the media would be gone.
  await page.click('#to-comments');
  await page.evaluate(() => {
    location.hash = 't=90';
  });
  await expect.poll(() => page.url()).toContain('#t=90');
  await new Promise((r) => setTimeout(r, 1_000));

  const scan = await scanAgain(tabId);
  expect(scan.pageUrl).toContain('#t=90');
  expect(lists(scan, 'hash-one'), 'an anchor dropped the route media').toBe(true);
});

// ─── The Navigation API ──────────────────────────────────────────────────────

async function hasNavigationApi(page: Page): Promise<void> {
  expect(await page.evaluate(() => 'navigation' in window), 'no Navigation API here').toBe(true);
}

test("D17: navigation.navigate() that the app intercepts replaces the old route's media", async () => {
  const { page, tabId } = await openApp('/navapi');
  await hasNavigationApi(page);
  await waitForScan(tabId, (scan) => lists(scan, 'navapi-one'));

  // The router's handler fetches the new route's manifest, and only then does
  // the navigation succeed: a second "new route" there would lose it.
  await page.evaluate(async () => {
    const { navigation } = window as unknown as {
      navigation: {
        navigate(url: string, options: { info: string }): { finished: Promise<unknown> };
      };
    };
    await navigation.navigate('/navapi/two', { info: 'router' }).finished;
  });
  const onRouteTwo = (scan: ScanShape) =>
    scan.pageUrl.endsWith('/navapi/two') && lists(scan, 'navapi-two');
  const scan = await waitForScan(tabId, onRouteTwo);
  expect(lists(scan, 'navapi-one'), 'the old route media was kept').toBe(false);

  await settle();
  const settled = await waitForScan(tabId, onRouteTwo, 5_000);
  expect(lists(settled, 'navapi-one'), 'the old route media came back').toBe(false);
});

test('D17: a pushState the Navigation API also reports is one route change, not two', async () => {
  const { page, tabId } = await openApp('/navapi');
  await hasNavigationApi(page);
  await waitForScan(tabId, (scan) => lists(scan, 'navapi-one'));

  // pushState, then the player fetches at once. In Chromium the Navigation
  // API reports the same move (navigatesuccess comes after the fetch started);
  // counted twice, the second route would begin after the fetch and drop it.
  await page.evaluate(() => {
    (window as unknown as { pushRoute(path: string): void }).pushRoute('/navapi/three');
  });
  const onRouteThree = (scan: ScanShape) =>
    scan.pageUrl.endsWith('/navapi/three') && lists(scan, 'navapi-three');
  const scan = await waitForScan(tabId, onRouteThree);
  expect(lists(scan, 'navapi-one'), 'the old route media was kept').toBe(false);

  await settle();
  await waitForScan(tabId, onRouteThree, 5_000);
});
