/**
 * The segmented engine's last step, with the network parts replaced: what it
 * does when the user stops the task after the final segment has arrived.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __setBrowserApi } from '../../src/browser/index.ts';
import { ErrorCode } from '../../src/core/errors.ts';
import type { MediaCandidate } from '../../src/core/types.ts';
import { browserEngine, type EngineRun, segmentedEngine } from '../../src/downloads/engines.ts';
import { DEFAULT_SETTINGS } from '../../src/storage/settings.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';

const released: string[] = [];
const assembled: string[] = [];

vi.mock('../../src/downloads/plan-builder.ts', () => ({
  buildPlanForVariant: async () => ({
    plan: { segments: [{ url: 'https://cdn.example/s.ts' }], totalDuration: 4, live: false },
    container: 'ts',
  }),
}));
vi.mock('../../src/downloads/assembly-host.ts', () => ({
  // Like the real one: reports progress for the last segment, then returns the blob.
  assemble: async (request: {
    taskId: string;
    onProgress?: (a: number, b: number, c: number) => void;
  }) => {
    assembled.push(request.taskId);
    request.onProgress?.(3, 1, 1);
    return { objectUrl: 'blob:assembled', totalBytes: 3 };
  },
  releaseObjectUrl: async (url: string) => {
    released.push(url);
  },
}));

afterEach(() => {
  __setBrowserApi(null);
  released.length = 0;
  assembled.length = 0;
});

describe('segmented engine', () => {
  it('re-review: never asks the browser to save a download the user already stopped', async () => {
    const api = createFakeBrowserApi();
    const download = vi.fn(async () => 1);
    api.downloads.download = download;
    __setBrowserApi(api);

    const controller = new AbortController();
    const candidate = {
      id: 'c',
      url: 'https://cdn.example/index.m3u8',
      pageUrl: 'https://site.example/',
      kind: 'video',
      protocol: 'hls',
      format: 'ts',
      source: 'network',
      seenAt: 0,
      tracks: { video: true, audio: true },
    } satisfies MediaCandidate;

    const running = segmentedEngine.start({
      request: {
        taskId: 't',
        url: candidate.url,
        strategy: 'segment-hls',
        filename: 'MediaGrab/x.ts',
        kind: 'video',
        pageUrl: candidate.pageUrl,
      },
      candidate,
      variant: {
        id: 'v',
        url: candidate.url,
        kind: 'video',
        protocol: 'hls',
        format: 'ts',
        tracks: candidate.tracks,
      },
      settings: DEFAULT_SETTINGS,
      signal: controller.signal,
      onProgress: () => controller.abort(), // the user cancels as the last bytes land
      onVerifying: () => undefined,
      rename: (extension) => `MediaGrab/x.${extension}`,
      willFetch: async () => undefined,
    });

    await expect(running).rejects.toMatchObject({ code: ErrorCode.CANCELLED });
    expect(download).not.toHaveBeenCalled();
    expect(released).toEqual(['blob:assembled']);
  });
});

/** A run whose `willFetch` lets the test stop the task while the Referer rule is being set. */
function runStoppedWhileNamingThePage(strategy: 'browser-download' | 'segment-hls', stopAt = 1) {
  const controller = new AbortController();
  const candidate = {
    id: 'c',
    url: 'https://cdn.example/index.m3u8',
    pageUrl: 'https://site.example/',
    kind: 'video',
    protocol: 'hls',
    format: 'ts',
    source: 'network',
    seenAt: 0,
    tracks: { video: true, audio: true },
  } satisfies MediaCandidate;
  let calls = 0;
  const run: EngineRun = {
    request: {
      taskId: 't',
      url: candidate.url,
      strategy,
      filename: 'MediaGrab/x.ts',
      kind: 'video',
      pageUrl: candidate.pageUrl,
    },
    candidate,
    variant: {
      id: 'v',
      url: candidate.url,
      kind: 'video',
      protocol: 'hls',
      format: 'ts',
      tracks: candidate.tracks,
    },
    settings: DEFAULT_SETTINGS,
    signal: controller.signal,
    onProgress: () => undefined,
    onVerifying: () => undefined,
    rename: (extension) => `MediaGrab/x.${extension}`,
    willFetch: async () => {
      calls += 1;
      if (calls === stopAt) controller.abort(); // the user stops it meanwhile
    },
  };
  return run;
}

describe('re-audit: a stop while the Referer rule is being set (D18)', () => {
  it('a direct file never reaches the browser (no Save dialog for a cancelled download)', async () => {
    const api = createFakeBrowserApi();
    const download = vi.fn(async () => 1);
    api.downloads.download = download;
    __setBrowserApi(api);
    await expect(
      browserEngine.start(runStoppedWhileNamingThePage('browser-download')),
    ).rejects.toMatchObject({
      code: ErrorCode.CANCELLED,
    });
    expect(download).not.toHaveBeenCalled();
  });

  it('a segmented download never asks the offscreen document to fetch the stream', async () => {
    __setBrowserApi(createFakeBrowserApi());
    for (const stopAt of [1, 2]) {
      await expect(
        segmentedEngine.start(runStoppedWhileNamingThePage('segment-hls', stopAt)),
      ).rejects.toMatchObject({ code: ErrorCode.CANCELLED });
    }
    expect(assembled).toEqual([]);
  });
});
