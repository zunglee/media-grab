/**
 * The test that was missing: loads the real built extension into a real
 * Chromium, points it at a local fixture site, and checks that the pipeline
 * actually runs — background worker boots, content script injects, page hook
 * reports, network observer sees the manifest, the engine scores and ranks, and
 * a download completes to a real file on disk.
 *
 * It runs against `dist/chrome-test`, which is the shipping Chrome build with
 * two manifest changes: host permissions for 127.0.0.1 granted up front, and a
 * declarative content script. Both exist because the browser's own permission
 * prompt cannot be scripted. Everything else — every line of the worker, the
 * engine, the parsers and the download manager — is the shipping code.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
  type Worker,
} from '@playwright/test';
import { type FixtureSite, startFixtureSite } from './fixture-site.ts';

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, '../../dist/chrome-test');

let site: FixtureSite;
let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let downloadDir: string;

/** Chromium reads the download directory out of the profile, not from a flag. */
function seedProfile(userDataDir: string, downloads: string): void {
  const profile = join(userDataDir, 'Default');
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, 'Preferences'),
    JSON.stringify({
      download: {
        default_directory: downloads,
        prompt_for_download: false,
        directory_upgrade: true,
      },
      profile: { default_content_setting_values: {} },
    }),
  );
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  site = await startFixtureSite();

  const userDataDir = mkdtempSync(join(tmpdir(), 'mediagrab-profile-'));
  downloadDir = mkdtempSync(join(tmpdir(), 'mediagrab-downloads-'));
  seedProfile(userDataDir, downloadDir);

  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });

  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  await site?.close();
});

/** Read the scan the worker stored for a tab, retrying while detection settles. */
async function waitForScan(
  tabId: number,
  predicate: (scan: ScanShape) => boolean,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last: ScanShape | undefined;
  while (Date.now() < deadline) {
    last = (await worker.evaluate(async (id) => {
      const key = `scan:${id}`;
      const stored = await chrome.storage.session.get(key);
      return stored[key] ?? null;
    }, tabId)) as ScanShape | undefined;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(
    `scan never satisfied the predicate. Last value: ${JSON.stringify(last, null, 2)}`,
  );
}

interface ScanShape {
  pageUrl: string;
  pageTitle: string;
  candidates: Array<{
    id: string;
    url: string;
    kind: string;
    protocol: string;
    score?: number;
    title?: string;
    posterUrl?: string;
    variants?: Array<{ id: string; url: string; resolution?: { height: number } }>;
    drm?: boolean;
  }>;
  rejected: Array<{ url: string; reason: string }>;
  stats: Record<string, unknown>;
  diagnosis?: { code: string };
}

async function openFixture(path = '/watch'): Promise<{ tabId: number; page: Page }> {
  const page = await context.newPage();
  await page.goto(`${site.origin}${path}`);
  await page.waitForLoadState('networkidle');
  // Earlier tests leave their tabs open; the newest one for this URL is ours.
  const tabId = (await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    return tabs.at(-1)?.id ?? -1;
  }, `${site.origin}${path}`)) as number;
  expect(tabId).toBeGreaterThan(0);
  return { tabId, page };
}

/** Send a message the way the popup does: from one of the extension's own pages. */
async function fromExtensionPage<T>(message: Record<string, unknown>): Promise<T> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  try {
    return (await page.evaluate(async (m) => chrome.runtime.sendMessage(m), message)) as T;
  } finally {
    await page.close();
  }
}

test('the background worker boots without errors', async () => {
  const alive = await worker.evaluate(() => typeof chrome.runtime.getManifest().name === 'string');
  expect(alive).toBe(true);
  const manifestName = await worker.evaluate(() => chrome.runtime.getManifest().name);
  expect(manifestName).toBe('MediaGrab (test build)');
});

test('detects the progressive file and the HLS ladder on a real page', async () => {
  const { tabId } = await openFixture();

  const scan = await waitForScan(tabId, (s) =>
    s.candidates.some((c) => c.protocol === 'hls' && (c.variants?.length ?? 0) > 0),
  );

  const hls = scan.candidates.find((c) => c.protocol === 'hls');
  expect(hls, 'HLS master playlist was not detected').toBeDefined();
  expect(hls?.variants?.length, 'the master playlist was not expanded into a ladder').toBe(3);
  expect(hls?.variants?.map((v) => v.resolution?.height)).toEqual([1080, 720, 480]);

  const mp4 = scan.candidates.find((c) => c.url.endsWith('/media/feature.mp4'));
  expect(mp4, 'the <source> file was not detected').toBeDefined();
  expect(mp4?.kind).toBe('video');

  // The page title reaches the candidate, which is what naming depends on.
  expect(hls?.title ?? mp4?.title).toContain('Deep Sea Documentary');

  // The manifest was found by the network observer, which sees a URL and two
  // headers - so its preview can only come from the back-fill.
  expect(hls?.posterUrl, 'the HLS row would render with no preview').toContain('poster.jpg');
});

test('scores the advert and the poster below the display threshold', async () => {
  const { tabId } = await openFixture();
  const scan = await waitForScan(tabId, (s) => s.candidates.length > 0);

  const shown = scan.candidates.map((c) => c.url);
  expect(
    shown.some((url) => url.includes('/ads/preroll.mp4')),
    'the advert was offered',
  ).toBe(false);
  expect(
    shown.some((url) => url.includes('poster.jpg')),
    'the poster was offered',
  ).toBe(false);

  const rejectedUrls = scan.rejected.map((r) => r.url);
  expect(rejectedUrls.some((url) => url.includes('preroll'))).toBe(true);
});

test('reports no diagnosis when it found usable media', async () => {
  const { tabId } = await openFixture();
  const scan = await waitForScan(tabId, (s) => s.candidates.length > 0);
  expect(scan.diagnosis).toBeUndefined();
});

/** Ask the background to download, the way the popup does. */
async function startDownload(tabId: number, candidateId: string, variantId?: string) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const result = await page.evaluate(
    async ([id, candidate, variant]) =>
      chrome.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        tabId: Number(id),
        candidateId: candidate,
        ...(variant ? { variantId: variant } : {}),
      }),
    [String(tabId), candidateId, variantId ?? ''] as const,
  );
  await page.close();
  return result as { ok: boolean; taskId?: string; error?: string };
}

interface TaskShape {
  id: string;
  state: string;
  strategy: string;
  filename: string;
  browserDownloadId?: number;
  progress: { receivedBytes: number; totalBytes?: number };
  error?: { code: string; message: string };
}

/**
 * Assert through MediaGrab's own task record and the browser's download record,
 * not the filesystem: Playwright intercepts extension downloads and renames
 * them into its artifact directory, so a file-on-disk check would be testing
 * Playwright rather than the extension.
 */
async function waitForTask(taskId: string, state: string, timeoutMs = 40_000): Promise<TaskShape> {
  return waitForTaskWhere(taskId, (task) => task.state === state, `state ${state}`, timeoutMs);
}

async function waitForTaskWhere(
  taskId: string,
  predicate: (task: TaskShape) => boolean,
  description: string,
  timeoutMs = 40_000,
): Promise<TaskShape> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  try {
    const deadline = Date.now() + timeoutMs;
    let last: TaskShape | undefined;
    while (Date.now() < deadline) {
      const response = (await page.evaluate(async () =>
        chrome.runtime.sendMessage({ type: 'GET_DOWNLOADS' }),
      )) as { tasks: TaskShape[] };
      last = response.tasks.find((task) => task.id === taskId);
      if (last && predicate(last)) return last;
      if (last?.state === 'FAILED') {
        throw new Error(`task failed: ${last.error?.code} ${last.error?.message}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(
      `task ${taskId} never reached ${description}. Last: ${JSON.stringify(last, null, 2)}`,
    );
  } finally {
    await page.close();
  }
}

/** What the browser itself recorded for that download. */
async function browserRecord(downloadId: number) {
  return (await worker.evaluate(async (id) => {
    const [item] = await chrome.downloads.search({ id });
    return item
      ? { state: item.state, bytesReceived: item.bytesReceived, error: item.error ?? null }
      : null;
  }, downloadId)) as { state: string; bytesReceived: number; error: string | null } | null;
}

test('downloads a progressive file and reports real byte progress', async () => {
  const { tabId } = await openFixture();
  const scan = await waitForScan(tabId, (s) =>
    s.candidates.some((c) => c.url.endsWith('/media/feature.mp4')),
  );
  const mp4 = scan.candidates.find((c) => c.url.endsWith('/media/feature.mp4'));

  const result = await startDownload(tabId, mp4?.id ?? '');
  expect(result.error ?? '').toBe('');
  expect(result.ok).toBe(true);

  const task = await waitForTask(result.taskId ?? '', 'COMPLETED');

  // Naming: the page title, cleaned of its site suffix, inside the base folder.
  expect(task.filename).toMatch(/^MediaGrab\/Deep Sea Documentary.*\.mp4$/);

  // Progress must agree with the browser rather than sitting at zero, which is
  // what `downloads.onChanged` alone would leave it at.
  expect(task.progress.receivedBytes, 'progress never caught up with the browser').toBe(
    site.sizes.featureMp4,
  );

  const record = await browserRecord(task.browserDownloadId ?? -1);
  expect(record?.state).toBe('complete');
  expect(record?.bytesReceived).toBe(site.sizes.featureMp4);
});

test('downloads an HLS rendition by fetching and assembling its segments', async () => {
  const { tabId } = await openFixture();
  const scan = await waitForScan(tabId, (s) =>
    s.candidates.some((c) => c.protocol === 'hls' && (c.variants?.length ?? 0) > 0),
  );
  const hls = scan.candidates.find((c) => c.protocol === 'hls');
  const variant = hls?.variants?.find((v) => v.resolution?.height === 1080);
  expect(variant, 'no 1080p rendition in the ladder').toBeDefined();

  const result = await startDownload(tabId, hls?.id ?? '', variant?.id);
  expect(result.error ?? '').toBe('');
  expect(result.ok).toBe(true);

  const task = await waitForTask(result.taskId ?? '', 'COMPLETED');
  expect(task.filename).toMatch(/1080p/);
  // Pass 2 regression: the playlist has EXT-X-MAP, so the joined segments are
  // fMP4. 0.1.4 saved them as ".ts".
  expect(task.filename).toMatch(/\.mp4$/);

  // init + every segment, in order, assembled through the offscreen document.
  const expected = site.sizes.hlsInit + site.sizes.hlsSegment * site.sizes.hlsSegments;
  expect(task.progress.receivedBytes, 'assembled size is not init + every segment').toBe(expected);

  const record = await browserRecord(task.browserDownloadId ?? -1);
  expect(record?.state).toBe('complete');
  expect(record?.bytesReceived).toBe(expected);
});

test('expands a DASH manifest into its video and audio representations', async () => {
  const { tabId } = await openFixture();
  const scan = await waitForScan(tabId, (s) =>
    s.candidates.some((c) => c.protocol === 'dash' && (c.variants?.length ?? 0) > 0),
  );

  const dash = scan.candidates.find((c) => c.protocol === 'dash');
  expect(dash, 'the MPD was not detected').toBeDefined();
  // Video representations are the selectable ladder; audio is carried separately
  // because DASH splits them and MediaGrab does not mux.
  expect(dash?.variants?.map((v) => v.resolution?.height)).toEqual([1080, 720]);
});

test('downloads a DASH representation by enumerating its segment template', async () => {
  const { tabId } = await openFixture();
  const scan = await waitForScan(tabId, (s) =>
    s.candidates.some((c) => c.protocol === 'dash' && (c.variants?.length ?? 0) > 0),
  );
  const dash = scan.candidates.find((c) => c.protocol === 'dash');
  const variant = dash?.variants?.find((v) => v.resolution?.height === 1080);
  expect(variant, 'no 1080p representation').toBeDefined();

  const result = await startDownload(tabId, dash?.id ?? '', variant?.id);
  expect(result.error ?? '').toBe('');
  expect(result.ok).toBe(true);

  const task = await waitForTask(result.taskId ?? '', 'COMPLETED');

  // $Number%05d$ expanded correctly across the whole period, init included.
  const expected = site.sizes.dashInit + site.sizes.dashSegment * site.sizes.dashSegments;
  expect(task.progress.receivedBytes, 'assembled size is not init + every segment').toBe(expected);

  const record = await browserRecord(task.browserDownloadId ?? -1);
  expect(record?.state).toBe('complete');
});

test('collapses a second request for a download that is already running', async () => {
  const { tabId } = await openFixture();
  const scan = await waitForScan(tabId, (s) =>
    s.candidates.some((c) => c.url.endsWith('/media/feature.mp4')),
  );
  const mp4 = scan.candidates.find((c) => c.url.endsWith('/media/feature.mp4'));

  // Both requests are issued in the same turn, which is what a double click
  // produces. Issuing them sequentially would let the first finish first, and a
  // finished download is deliberately allowed to be requested again.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const both = (await page.evaluate(
    async ([id, candidate]) => {
      const send = () =>
        chrome.runtime.sendMessage({
          type: 'START_DOWNLOAD',
          tabId: Number(id),
          candidateId: candidate,
        });
      return Promise.all([send(), send()]);
    },
    [String(tabId), mp4?.id ?? ''] as const,
  )) as Array<{ ok: boolean; taskId?: string }>;
  await page.close();

  expect(both).toHaveLength(2);
  const [first, second] = both as [
    { ok: boolean; taskId?: string },
    { ok: boolean; taskId?: string },
  ];
  expect(first.ok && second.ok).toBe(true);
  expect(second.taskId, 'a double click produced two downloads of one file').toBe(first.taskId);

  await waitForTask(first.taskId ?? '', 'COMPLETED');
});

test('detects DRM and refuses to download it', async () => {
  const { tabId } = await openFixture();
  const scan = await waitForScan(tabId, (s) =>
    s.candidates.concat(s.rejected as never[]).some(() => true),
  );

  // A protected stream is never offered as a normal option.
  const offered = scan.candidates.filter((c) => c.drm !== true);
  expect(offered.some((c) => c.url.includes('protected.mpd'))).toBe(false);

  // And if something asks for it by id anyway, the manager refuses before a
  // single byte is fetched.
  const drmId = (await worker.evaluate(async (id) => {
    const key = `scan:${id}`;
    const stored = (await chrome.storage.session.get(key))[key] as
      | { candidates: Array<{ id: string; url: string; drm?: boolean }> }
      | undefined;
    const hit = stored?.candidates.find((c) => c.url.includes('protected.mpd'));
    return hit?.drm === true ? hit.id : '';
  }, tabId)) as string;

  if (drmId) {
    const result = await startDownload(tabId, drmId);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/[Pp]rotected/);
  }
});

test('refuses a download for a candidate that is no longer in the scan', async () => {
  const { tabId } = await openFixture();
  await waitForScan(tabId, (s) => s.candidates.length > 0);
  const result = await startDownload(tabId, 'not-a-real-candidate-id');
  expect(result.ok).toBe(false);
  expect(result.error).toContain('scan');
});

test('documents what actually reaches the server on a segment request', async () => {
  const { tabId } = await openFixture();
  const scan = await waitForScan(tabId, (s) =>
    s.candidates.some((c) => c.protocol === 'hls' && (c.variants?.length ?? 0) > 0),
  );
  const hls = scan.candidates.find((c) => c.protocol === 'hls');
  const variant = hls?.variants?.find((v) => v.resolution?.height === 1080);

  const before = site.requests.length;
  const result = await startDownload(tabId, hls?.id ?? '', variant?.id);
  await waitForTask(result.taskId ?? '', 'COMPLETED');

  const segmentRequests = site.requests
    .slice(before)
    .filter((entry) => entry.path.includes('/1080/seg-'));
  expect(segmentRequests.length).toBeGreaterThan(0);

  // D18: `fetch` cannot send a Referer, so a session declarativeNetRequest rule
  // names the page - on MediaGrab's own requests, to a host it may access (the
  // test build is granted this one). No cookie is ever sent. This pins what
  // actually reaches the server, so SECURITY.md cannot drift from it.
  expect(segmentRequests.every((entry) => entry.referer === `${site.origin}/watch`)).toBe(true);
});

test('finds media that only the DOM knows about', async () => {
  // `preload="none"`: the page never requests the file, so the network observer
  // has nothing and the content script's report is the only source. In 0.1.3
  // the report's two halves raced in the worker and the page context write
  // erased the candidates, so a page like this showed nothing at all.
  const { tabId } = await openFixture('/slow');
  const scan = await waitForScan(tabId, (s) =>
    s.candidates.some((c) => c.url.endsWith('/media/slow.mp4')),
  );
  expect(scan.pageTitle).toContain('Slow Feature');
});

test('an embedded player neither replaces the page nor erases its media', async () => {
  const { tabId } = await openFixture('/framed');
  const both = (scan: ScanShape) =>
    scan.candidates.some((c) => c.url.endsWith('/media/feature.mp4')) &&
    scan.candidates.some((c) => c.url.endsWith('/media/embedded.mp4'));
  await waitForScan(tabId, both);

  // Let every frame's late pass (2.5 s) report too. In 0.1.3 each iframe report
  // looked like a navigation and wiped the tab, so the state flip-flopped.
  await new Promise((r) => setTimeout(r, 3_500));
  const settled = await waitForScan(tabId, both, 5_000);
  expect(settled.pageUrl).toBe(`${site.origin}/framed`);
  expect(settled.pageTitle).toContain('Framed Feature');
});

test('a fragment change keeps the embedded player, and "Scan again" still finds it', async () => {
  const { tabId, page } = await openFixture('/framed');
  const both = (scan: ScanShape) =>
    scan.candidates.some((c) => c.url.endsWith('/media/feature.mp4')) &&
    scan.candidates.some((c) => c.url.endsWith('/media/embedded.mp4'));
  await waitForScan(tabId, both);

  // An anchor or a `#t=` link is not a new page; the iframe is still there.
  await page.evaluate(() => {
    location.hash = 't=90';
  });
  const reply = await fromExtensionPage<{ result: ScanShape }>({ type: 'REQUEST_SCAN', tabId });
  expect(both(reply.result), 'the embedded player was dropped').toBe(true);
});

test('"Scan again" answers with what the page shows now, not at its last report', async () => {
  const { tabId, page } = await openFixture('/watch');
  await waitForScan(tabId, (s) => s.candidates.length > 0);

  // Added and scanned in the same breath: the content script's own debounced
  // report has not fired yet, so only a scan that waits for a fresh report
  // from the page can include it.
  await page.evaluate(() => {
    const video = document.createElement('video');
    video.src = '/media/late-arrival.mp4';
    video.title = 'Late arrival';
    document.body.append(video);
  });
  const reply = await fromExtensionPage<{ result: ScanShape }>({ type: 'REQUEST_SCAN', tabId });
  expect(reply.result.candidates.some((c) => c.url.endsWith('/media/late-arrival.mp4'))).toBe(true);
});

test('pauses and resumes a direct download in the browser, without a second copy', async () => {
  const { tabId } = await openFixture('/slow');
  const scan = await waitForScan(tabId, (s) =>
    s.candidates.some((c) => c.url.endsWith('/media/slow.mp4')),
  );
  const slow = scan.candidates.find((c) => c.url.endsWith('/media/slow.mp4'));
  const started = await startDownload(tabId, slow?.id ?? '');
  expect(started.error ?? '').toBe('');
  const taskId = started.taskId ?? '';

  const running = await waitForTaskWhere(
    taskId,
    (task) => task.state === 'DOWNLOADING' && task.progress.receivedBytes > 0,
    'bytes flowing',
  );
  const downloadId = running.browserDownloadId ?? -1;

  await fromExtensionPage({ type: 'DOWNLOAD_COMMAND', taskId, command: 'pause' });
  await expect
    .poll(async () =>
      worker.evaluate(async (id) => (await chrome.downloads.search({ id }))[0]?.paused, downloadId),
    )
    .toBe(true);

  await fromExtensionPage({ type: 'DOWNLOAD_COMMAND', taskId, command: 'resume' });
  const done = await waitForTask(taskId, 'COMPLETED');
  expect(done.browserDownloadId, 'resume started a different download').toBe(downloadId);

  const record = await browserRecord(downloadId);
  expect(record?.state).toBe('complete');
  expect(record?.bytesReceived).toBe(site.sizes.slowMp4);

  const copies = await worker.evaluate(
    async (url) => (await chrome.downloads.search({ url })).length,
    slow?.url ?? '',
  );
  expect(copies, 'the file was downloaded twice').toBe(1);
});

// ─── Pass 2: each fixture has exactly one way for its media to be found ──────

/** The candidate whose URL ends with `suffix`, once the scan has it. */
async function scanFinding(tabId: number, suffix: string) {
  const scan = await waitForScan(tabId, (s) => s.candidates.some((c) => c.url.endsWith(suffix)));
  return { scan, found: scan.candidates.find((c) => c.url.endsWith(suffix)) };
}

test('pass 2 regression: finds an extensionless manifest loaded by XHR from an ungranted CDN', async () => {
  // Only the page hook's XHR response-type check can see this: no extension to
  // match, no DOM element, and a host the network observer has no grant for.
  const { tabId } = await openFixture('/cdn-xhr');
  const { found } = await scanFinding(tabId, '/cdn/stream');
  expect(found?.url.startsWith(site.cdnOrigin)).toBe(true);
  expect(found?.protocol).toBe('hls');
  expect(found?.variants?.length, 'the worker could not expand the CDN manifest').toBe(3);
});

test('pass 2 regression: finds a manifest only Resource Timing saw (preloaded, ungranted CDN)', async () => {
  const { tabId } = await openFixture('/preload');
  const { found } = await scanFinding(tabId, '/cdn/preloaded.m3u8');
  expect(found?.protocol).toBe('hls');
});

test('pass 2 regression: stream segments and nested playlists are never rows of their own', async () => {
  const { tabId } = await openFixture('/segments');
  const scan = await waitForScan(tabId, (s) =>
    s.candidates.some((c) => c.url.endsWith('/media/master.m3u8') && (c.variants?.length ?? 0) > 0),
  );
  const urls = scan.candidates.map((c) => c.url);
  expect(
    urls.filter((url) => /\.ts$/.test(url)),
    'a segment became a download',
  ).toEqual([]);
  expect(
    urls.filter((url) => url.endsWith('/720/index.m3u8')),
    'a rendition shown twice',
  ).toEqual([]);
});

test('pass 2 regression: resolves against <base href> and keeps each <source> type', async () => {
  const { tabId } = await openFixture('/base/page');
  const scan = await waitForScan(
    tabId,
    (s) =>
      s.candidates.some((c) => c.url === `${site.origin}/assets/clip.mp4`) &&
      s.candidates.some((c) => c.url === `${site.origin}/assets/alt.mp4`),
  );
  const alt = scan.candidates.find((c) => c.url === `${site.origin}/assets/alt.mp4`) as
    | (ScanShape['candidates'][number] & { format?: string })
    | undefined;
  expect(alt?.format, 'the MP4 took the WebM source type').toBe('mp4');
  expect(scan.candidates.some((c) => c.url.includes('/base/assets/'))).toBe(false);
});

test('pass 2 regression: a MediaSource player gives an explanation, not a blob: download', async () => {
  const { tabId } = await openFixture('/mse');
  const scan = await waitForScan(tabId, (s) => s.diagnosis?.code === 'MSE_ONLY');
  expect(scan.candidates.filter((c) => c.url.startsWith('blob:'))).toEqual([]);
});

test('pass 2 regression: probing for DRM support does not make a clear video "protected"', async () => {
  const { tabId } = await openFixture('/probe');
  // The probe runs at 1.5 s; the late pass (2.5 s) reports whatever it caused.
  await new Promise((r) => setTimeout(r, 3_500));
  const scan = await waitForScan(tabId, (s) => s.diagnosis !== undefined);
  expect(scan.diagnosis?.code).toBe('NOT_STARTED');
});

test("pass 2 regression: a single-page app's new route replaces the old route's media", async () => {
  const { tabId } = await openFixture('/spa');
  await scanFinding(tabId, '/media/old-route.mp4');
  const scan = await waitForScan(
    tabId,
    (s) =>
      s.pageUrl.endsWith('/spa/next') && s.candidates.some((c) => c.url.endsWith('/manifest.mpd')),
  );
  const urls = scan.candidates.map((c) => c.url);
  expect(
    urls.some((url) => url.endsWith('/old-route.mp4')),
    'old route media kept',
  ).toBe(false);
  expect(
    urls.some((url) => url.endsWith('/master.m3u8')),
    'old route manifest kept',
  ).toBe(false);
});

test('pass 2 regression: tidying the address with replaceState keeps the manifest', async () => {
  const page = await context.newPage();
  await page.goto(`${site.origin}/tidy?utm_source=newsletter`);
  const tabId = (await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    return tabs.at(-1)?.id ?? -1;
  }, `${site.origin}/tidy?utm_source=newsletter`)) as number;
  await expect.poll(() => page.url()).toBe(`${site.origin}/tidy`);
  await page.evaluate(() => document.body.append(document.createElement('video'))); // one more report
  await new Promise((r) => setTimeout(r, 1_500));
  const scan = await waitForScan(tabId, (s) => s.pageUrl === `${site.origin}/tidy`);
  expect(scan.candidates.some((c) => c.url.endsWith('/media/master.m3u8'))).toBe(true);
});

test('pass 2 regression: a single-file DASH representation downloads as a plain file', async () => {
  const { tabId } = await openFixture('/ondemand');
  const { found } = await scanFinding(tabId, '/media/ondemand.mpd');
  const variant = found?.variants?.[0];
  expect(variant?.url.endsWith('/ondemand/video_720.mp4')).toBe(true);

  const started = await startDownload(tabId, found?.id ?? '', variant?.id);
  expect(started.error ?? '').toBe('');
  const task = await waitForTask(started.taskId ?? '', 'COMPLETED');
  // The browser streams it to disk, once, whole - no duplicated ftyp/moov.
  expect(task.strategy).toBe('browser-download');
  const record = await browserRecord(task.browserDownloadId ?? -1);
  expect(record?.bytesReceived).toBe(site.sizes.onDemandMp4);
});
