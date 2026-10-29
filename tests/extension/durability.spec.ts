/**
 * The release gates that used to be manual (TESTING.md § 5), in a real
 * Chromium with the real extension:
 *
 *   D16  the service worker is stopped (as Chrome does when it is idle) or the
 *        extension is reloaded (as an update does) in the middle of a download,
 *        and the next worker takes charge of what the last one left;
 *   D18  the page is named as Referer to a host MediaGrab may access, and a host
 *        it may not access is offered for a grant instead of failing blindly.
 *
 * Stopping the worker uses the DevTools protocol's `Target.closeTarget`, the
 * same call Chrome's own "test service worker termination" guide uses.
 * Everything is asserted through an extension page (task list, storage) and the
 * browser's own download records - never through the worker handle, which dies
 * with the worker.
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
let extensionId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  site = await startFixtureSite();
  const userDataDir = mkdtempSync(join(tmpdir(), 'mediagrab-durability-'));
  const downloads = mkdtempSync(join(tmpdir(), 'mediagrab-durability-dl-'));
  mkdirSync(join(userDataDir, 'Default'), { recursive: true });
  writeFileSync(
    join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
  );
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  await site?.close();
});

interface TaskShape {
  id: string;
  state: string;
  filename: string;
  canRetry?: boolean;
  browserDownloadId?: number;
  progress: { receivedBytes: number };
  error?: { code: string; message: string; accessHost?: string };
}

/** Run `fn` in a fresh extension page, the way the popup talks to the worker. */
async function inExtension<T, A>(fn: (arg: A) => Promise<T>, arg: A): Promise<T> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const run = fn as (value: unknown) => Promise<unknown>;
    return (await page.evaluate(run, arg as unknown)) as T;
  } finally {
    await page.close().catch(() => undefined);
  }
}

const send = <T>(message: Record<string, unknown>) =>
  inExtension((m) => chrome.runtime.sendMessage(m) as Promise<T>, message);

async function tasks(): Promise<TaskShape[]> {
  return ((await send<{ tasks: TaskShape[] }>({ type: 'GET_DOWNLOADS' })) ?? { tasks: [] }).tasks;
}

async function until<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  what: string,
  ms = 40_000,
) {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`never: ${what}. Last: ${JSON.stringify(last, null, 2)}`);
}

const task = (id: string) =>
  until(
    async () => (await tasks()).find((entry) => entry.id === id),
    (entry) => entry !== undefined,
    `task ${id} listed`,
  ) as Promise<TaskShape>;

const taskWhere = (id: string, ok: (entry: TaskShape) => boolean, what: string) =>
  until(
    async () => (await tasks()).find((entry) => entry.id === id),
    (entry) => entry !== undefined && ok(entry),
    what,
  ) as Promise<TaskShape>;

async function open(path: string): Promise<{ tabId: number; page: Page }> {
  const page = await context.newPage();
  await page.goto(`${site.origin}${path}`);
  await page.waitForLoadState('networkidle');
  const tabs = await inExtension(
    async (url) => chrome.tabs.query({ url }),
    `${site.origin}${path}`,
  );
  const tabId = tabs.at(-1)?.id ?? -1;
  expect(tabId).toBeGreaterThan(0);
  return { tabId, page };
}

async function candidateEndingWith(tabId: number, suffix: string): Promise<string> {
  const scan = await until(
    () =>
      inExtension(async (id) => {
        const key = `scan:${id}`;
        return ((await chrome.storage.session.get(key))[key] ?? null) as {
          candidates: Array<{ id: string; url: string }>;
        } | null;
      }, tabId),
    (value) => value?.candidates.some((c) => c.url.endsWith(suffix)) === true,
    `a candidate ending in ${suffix}`,
  );
  return scan?.candidates.find((c) => c.url.endsWith(suffix))?.id ?? '';
}

async function start(tabId: number, candidateId: string): Promise<string> {
  const reply = await send<{ ok: boolean; taskId?: string; error?: string }>({
    type: 'START_DOWNLOAD',
    tabId,
    candidateId,
  });
  expect(reply.error ?? '').toBe('');
  return reply.taskId ?? '';
}

/**
 * Stop the extension's service worker, as Chrome does when it is idle, and
 * prove it: a marker set in the old worker must be gone from whichever worker
 * runs next. (Something - a page report, a download event - may start a new
 * worker at once; that is fine, and it is exactly the case under test.)
 */
async function stopWorker(): Promise<void> {
  const ours = () =>
    context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extensionId}/`));
  const old = ours() ?? (await context.waitForEvent('serviceworker'));
  await old.evaluate(() => {
    (globalThis as Record<string, unknown>).__beforeStop = true;
  });

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const { targetInfos } = (await cdp.send('Target.getTargets')) as {
    targetInfos: Array<{ targetId: string; type: string; url: string }>;
  };
  const target = targetInfos.find(
    (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`),
  );
  expect(target, 'no running worker to stop').toBeDefined();
  await cdp.send('Target.closeTarget', { targetId: target?.targetId ?? '' });
  await cdp.detach();
  await page.close();

  // Wake a new worker and check it is not the old one.
  await tasks();
  await until(
    async () => {
      const current = ours();
      return current
        ? await current
            .evaluate(() => (globalThis as Record<string, unknown>).__beforeStop === true)
            .catch(() => true)
        : true;
    },
    (stillOld) => !stillOld,
    "a new worker without the old one's memory",
    15_000,
  );
}

async function browserItem(id: number) {
  return inExtension(async (downloadId) => {
    const [item] = await chrome.downloads.search({ id: downloadId });
    return item ? { state: item.state, paused: item.paused, bytes: item.bytesReceived } : null;
  }, id);
}

test('D18: the page is named as Referer to a host MediaGrab may access', async () => {
  const { tabId } = await open('/hotlink');
  const candidateId = await candidateEndingWith(tabId, '/hotlink/index.m3u8');
  const before = site.requests.length;
  const id = await start(tabId, candidateId);
  await taskWhere(id, (t) => t.state === 'COMPLETED', 'the protected stream to download');

  const segments = site.requests.slice(before).filter((r) => r.path.startsWith('/hotlink/seg-'));
  expect(segments.length).toBeGreaterThan(0);
  expect(segments.every((r) => r.referer === `${site.origin}/hotlink`)).toBe(true);
});

test('D18: a refusing host MediaGrab may not access is offered for a grant', async () => {
  const { tabId } = await open('/hotlink-cdn');
  const id = await start(tabId, await candidateEndingWith(tabId, '/cdn/hotlink/index.m3u8'));
  const failed = await taskWhere(
    id,
    (t) => t.state === 'FAILED' && t.error?.accessHost !== undefined,
    'a failure that offers the CDN host',
  );
  expect(failed.error?.code).toBe('STREAM_EXPIRED');
  expect(failed.error?.accessHost).toBe('[::1]');
});

test('D16: a download paused in the browser survives the worker being stopped', async () => {
  const { tabId } = await open('/slow');
  const id = await start(tabId, await candidateEndingWith(tabId, '/media/slow.mp4'));
  const running = await taskWhere(
    id,
    (t) => t.state === 'DOWNLOADING' && t.progress.receivedBytes > 0,
    'bytes flowing',
  );
  await send({ type: 'DOWNLOAD_COMMAND', taskId: id, command: 'pause' });
  await until(
    () => browserItem(running.browserDownloadId ?? -1),
    (i) => i?.paused === true,
    'paused',
  );

  await stopWorker();

  // The next message starts a new worker, which takes charge of the saved queue.
  expect((await task(id)).state).toBe('PAUSED');
  await send({ type: 'DOWNLOAD_COMMAND', taskId: id, command: 'resume' });
  const done = await taskWhere(id, (t) => t.state === 'COMPLETED', 'completion after resume');
  expect(done.browserDownloadId).toBe(running.browserDownloadId);
  expect((await browserItem(running.browserDownloadId ?? -1))?.bytes).toBe(site.sizes.slowMp4);
});

test('D16: a file that finishes while no worker runs still reaches history', async () => {
  const { tabId } = await open('/slow');
  const id = await start(tabId, await candidateEndingWith(tabId, '/media/slow.mp4'));
  const running = await taskWhere(
    id,
    (t) => t.state === 'DOWNLOADING' && t.progress.receivedBytes > 0,
    'bytes flowing',
  );
  await stopWorker();
  await until(
    () => browserItem(running.browserDownloadId ?? -1),
    (i) => i?.state === 'complete',
    'the browser to finish the file',
  );

  // The browser's "complete" event wakes a new worker, which finds the task.
  const history = await until(
    () =>
      inExtension(
        async () =>
          ((await chrome.storage.local.get('history')).history ?? []) as Array<{ id: string }>,
        undefined,
      ),
    (entries) => entries.some((entry) => entry.id === id),
    'a history entry for the finished file',
  );
  expect(history.some((entry) => entry.id === id)).toBe(true);
  expect((await task(id)).state).toBe('COMPLETED');
});

test('D16: after an update clears session storage, a paused download is followed by its id, without Retry', async () => {
  const { tabId } = await open('/slow');
  const id = await start(tabId, await candidateEndingWith(tabId, '/media/slow.mp4'));
  const running = await taskWhere(
    id,
    (t) => t.state === 'DOWNLOADING' && t.progress.receivedBytes > 0,
    'bytes flowing',
  );
  await send({ type: 'DOWNLOAD_COMMAND', taskId: id, command: 'pause' });
  await until(
    () => browserItem(running.browserDownloadId ?? -1),
    (i) => i?.paused === true,
    'paused',
  );

  // What an extension update or a browser restart does to MediaGrab's state:
  // session storage is cleared and a new worker starts. (A literal
  // `chrome.runtime.reload()` cannot be automated here - it leaves an extension
  // loaded from the command line blocked - so it stays a manual gate.)
  await inExtension(async () => chrome.storage.session.clear(), undefined);
  await stopWorker();

  const after = await task(id);
  expect(after.state).toBe('PAUSED');
  expect(after.canRetry).toBe(false);
  expect(
    JSON.stringify(
      await inExtension(async () => chrome.storage.local.get('downloads:trace'), undefined),
    ),
  ).not.toContain('http');
  await send({ type: 'DOWNLOAD_COMMAND', taskId: id, command: 'resume' });
  await taskWhere(id, (t) => t.state === 'COMPLETED', 'completion after the update');
});
