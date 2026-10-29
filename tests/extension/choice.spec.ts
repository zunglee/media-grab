/**
 * D20 and D21 in a real Chromium: what "best" means, and whether a stream can
 * be saved, decided during the scan (fixture-site.ts `choiceRoute`).
 *
 * Each /choice page's player fetches one HLS master and nothing more, so every
 * rendition playlist the site serves was asked for by MediaGrab: the scan's
 * one probe of the best rendition, or a download. That is what lets these
 * tests say "decided before the click" and "fetched once" from the server's
 * own request log. Everything else is asserted through the scan the worker
 * stores and the tasks it lists, read from an extension page the way the
 * popup reads them.
 *
 * The popup's "Best download" itself is unit-tested (tests/unit/best.test.ts):
 * the popup answers for the active tab of its window, which a test cannot put
 * a fixture page behind. The two messages it sends for a split stream are
 * sent here as it sends them.
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
  const userDataDir = mkdtempSync(join(tmpdir(), 'mediagrab-choice-'));
  const downloads = mkdtempSync(join(tmpdir(), 'mediagrab-choice-downloads-'));
  mkdirSync(join(userDataDir, 'Default'), { recursive: true });
  writeFileSync(
    join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloads, prompt_for_download: false },
    }),
  );
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
});

test.afterEach(async () => {
  for (const page of opened.splice(0)) await page.close().catch(() => undefined);
});

test.afterAll(async () => {
  await context?.close();
  await site?.close();
});

interface VariantShape {
  id: string;
  url: string;
  resolution?: { height: number };
  tracks: { video: boolean; audio: boolean };
  segmentCount?: number;
  saveability?: string;
}

interface CandidateShape {
  id: string;
  url: string;
  duration?: number;
  live?: boolean;
  saveability?: string;
  variants?: VariantShape[];
  audioTracks?: VariantShape[];
}

interface ScanShape {
  pageUrl: string;
  candidates: CandidateShape[];
}

interface TaskShape {
  id: string;
  state: string;
  filename: string;
  progress: { receivedBytes: number };
  error?: { code: string; message: string };
}

const message = <T>(body: Record<string, unknown>) =>
  extensionPage.evaluate((m) => chrome.runtime.sendMessage(m), body) as Promise<T>;

async function storedScan(tabId: number): Promise<ScanShape | null> {
  return (await extensionPage.evaluate(async (id) => {
    const key = `scan:${id}`;
    const stored = await chrome.storage.session.get(key);
    return stored[key] ?? null;
  }, tabId)) as ScanShape | null;
}

/** The fixture's stream, once the scan has decided whether it can be saved. */
async function decided(tabId: number, stream: string, timeoutMs = 20_000): Promise<CandidateShape> {
  const deadline = Date.now() + timeoutMs;
  let last: ScanShape | null = null;
  while (Date.now() < deadline) {
    last = await storedScan(tabId);
    const found = last?.candidates.find((c) => c.url.endsWith(`/choice/${stream}/master.m3u8`));
    if (found?.saveability) return found;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`the ${stream} stream was never decided. Last scan: ${JSON.stringify(last)}`);
}

async function openChoice(stream: string): Promise<number> {
  const page = await context.newPage();
  opened.push(page);
  await page.goto(`${site.origin}/choice/${stream}`);
  await page.waitForLoadState('networkidle');
  const tabId = (await extensionPage.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    return tabs.at(-1)?.id ?? -1;
  }, `${site.origin}/choice/${stream}`)) as number;
  expect(tabId).toBeGreaterThan(0);
  return tabId;
}

/** How many times the site served `path` so far. */
const served = (path: string) => site.requests.filter((request) => request.path === path).length;

async function waitForTask(taskId: string, timeoutMs = 40_000): Promise<TaskShape> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskShape | undefined;
  while (Date.now() < deadline) {
    const { tasks } = await message<{ tasks: TaskShape[] }>({ type: 'GET_DOWNLOADS' });
    last = tasks.find((task) => task.id === taskId);
    if (last?.state === 'COMPLETED') return last;
    if (last?.state === 'FAILED') {
      throw new Error(`task failed: ${last.error?.code} ${last.error?.message}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`task ${taskId} never completed. Last: ${JSON.stringify(last)}`);
}

// ─── D21: decided during the scan ────────────────────────────────────────────

test('D21: an AES-128 stream is listed as encrypted before anyone clicks', async () => {
  const tabId = await openChoice('encrypted');
  const stream = await decided(tabId, 'encrypted');

  expect(stream.saveability).toBe('encrypted');
  // The probe read the best rendition's playlist, and only that one.
  expect(served('/choice/encrypted/1080/index.m3u8')).toBe(1);
  expect(served('/choice/encrypted/720/index.m3u8')).toBe(0);
  // Its segments were never touched: the scan knew from the playlist alone.
  expect(
    site.requests.some((request) => request.path.includes('/choice/encrypted/1080/seg-')),
  ).toBe(false);
});

test('D21: the probe is cached - scanning again does not fetch the rendition again', async () => {
  const tabId = await openChoice('encrypted');
  await decided(tabId, 'encrypted');
  const before = served('/choice/encrypted/1080/index.m3u8');

  await message({ type: 'REQUEST_SCAN', tabId });
  await message({ type: 'REQUEST_SCAN', tabId });
  expect(served('/choice/encrypted/1080/index.m3u8')).toBe(before);
});

test('D21: a live stream is listed as live', async () => {
  const tabId = await openChoice('live');
  const stream = await decided(tabId, 'live');

  expect(stream.live).toBe(true);
  expect(stream.saveability).toBe('live');
});

test('D21: a rendition too large to assemble is marked, and a download without a pick takes the next', async () => {
  const tabId = await openChoice('large');
  const stream = await decided(tabId, 'large');
  const uhd = stream.variants?.find((variant) => variant.resolution?.height === 2160);
  const small = stream.variants?.find((variant) => variant.resolution?.height === 360);

  expect(stream.saveability).toBe('saveable');
  expect(stream.duration).toBeGreaterThan(0);
  expect(uhd?.saveability).toBe('too-large');
  expect(uhd?.segmentCount).toBe(site.sizes.choiceLargeSegments);
  expect(small?.saveability).toBeUndefined();

  // Queued with no rendition picked, as the context menu and the shortcut do:
  // the manager asks the same rule, which passes over the 4K rung.
  const started = await message<{ ok: boolean; taskId?: string; error?: string }>({
    type: 'START_DOWNLOAD',
    tabId,
    candidateId: stream.id,
  });
  expect(started.error ?? '').toBe('');
  const task = await waitForTask(started.taskId ?? '');
  expect(task.filename).toMatch(/360p/);
  expect(served('/choice/large/360/init.mp4')).toBe(1);
  expect(site.requests.some((request) => request.path.startsWith('/choice/large/2160/seg-'))).toBe(
    false,
  );
  expect(task.progress.receivedBytes).toBe(
    site.sizes.hlsInit + site.sizes.hlsSegment * site.sizes.choiceLargeSegments,
  );
});

// ─── D20: a split stream is two files ────────────────────────────────────────

test('D20: a split stream saves its best video and its audio as two files', async () => {
  const tabId = await openChoice('split');
  const stream = await decided(tabId, 'split');
  expect(stream.saveability).toBe('saveable');

  // What "best" names for it: the tallest video-only rendition and its audio.
  const video = stream.variants?.find((variant) => variant.resolution?.height === 1080);
  const [audio] = stream.audioTracks ?? [];
  expect(video?.tracks).toEqual({ video: true, audio: false });
  expect(audio?.tracks).toEqual({ video: false, audio: true });

  // The two messages the popup sends, in its order.
  const first = await message<{ ok: boolean; taskId?: string; error?: string }>({
    type: 'START_DOWNLOAD',
    tabId,
    candidateId: stream.id,
    variantId: video?.id,
  });
  const second = await message<{ ok: boolean; taskId?: string; error?: string }>({
    type: 'START_DOWNLOAD',
    tabId,
    candidateId: stream.id,
    variantId: audio?.id,
  });
  expect(first.error ?? '').toBe('');
  expect(second.error ?? '').toBe('');
  expect(second.taskId, 'the audio joined the video task').not.toBe(first.taskId);

  const expected = site.sizes.hlsInit + site.sizes.hlsSegment * site.sizes.hlsSegments;
  const [videoTask, audioTask] = await Promise.all([
    waitForTask(first.taskId ?? ''),
    waitForTask(second.taskId ?? ''),
  ]);
  expect(videoTask.filename).toMatch(/1080p/);
  expect(videoTask.progress.receivedBytes).toBe(expected);
  expect(audioTask.filename).toMatch(/English/);
  expect(audioTask.progress.receivedBytes).toBe(expected);
  expect(served('/choice/split/audio/init.mp4')).toBe(1);
});
