/**
 * 0.1.6 integration: the seams between the runway's workstreams - the "best"
 * rule reaching the keyboard shortcut and context menu (D20), an unsaveable
 * rendition refused by the manager as well as the popup (D21), and a separate
 * audio track saved as an audio file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BackgroundServices } from '../../src/background/services.ts';
import type { BrowserApi } from '../../src/browser/api.ts';
import { __setBrowserApi } from '../../src/browser/index.ts';
import { ErrorCode } from '../../src/core/errors.ts';
import type { MediaCandidate, MediaVariant, ScanResult } from '../../src/core/types.ts';
import { DownloadManager } from '../../src/downloads/manager.ts';
import { createTask } from '../../src/downloads/task-factory.ts';
import { DEFAULT_SETTINGS } from '../../src/storage/settings.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';

const PAGE = 'https://example.test/watch'; // the fake browser's tab URL

function dashVideo(height: number, bandwidth: number): MediaVariant {
  return {
    id: `v${height}`,
    url: 'https://cdn.example/m.mpd',
    kind: 'video',
    protocol: 'dash',
    format: 'mp4',
    bandwidth,
    resolution: { width: Math.round((height * 16) / 9), height },
    tracks: { video: true, audio: false },
  };
}

function dashAudio(id: string, bandwidth: number): MediaVariant {
  return {
    id,
    url: 'https://cdn.example/m.mpd',
    kind: 'audio',
    protocol: 'dash',
    format: 'mp4',
    bandwidth,
    tracks: { video: false, audio: true },
  };
}

function splitStream(): MediaCandidate {
  return {
    id: 'split',
    url: 'https://cdn.example/m.mpd',
    pageUrl: PAGE,
    pageTitle: 'Feature',
    kind: 'video',
    protocol: 'dash',
    format: 'mp4',
    source: 'network',
    seenAt: 1,
    score: 80,
    tracks: { video: true, audio: false },
    variants: [dashVideo(720, 2_600_000), dashVideo(1080, 4_800_000)],
    audioTracks: [dashAudio('a128', 128_000)],
  };
}

afterEach(() => __setBrowserApi(null));

describe('0.1.6 integration', () => {
  it('D20: the shortcut and context menu queue the video and its audio, as the popup does', async () => {
    const api = createFakeBrowserApi();
    __setBrowserApi(api as BrowserApi);
    const scan: ScanResult = {
      tabId: 1,
      pageUrl: PAGE,
      pageTitle: 'Feature',
      scannedAt: 0,
      candidates: [splitStream()],
      rejected: [],
      stats: {} as ScanResult['stats'],
    };
    await api.storage.session.set('scan:1', scan);

    const services = new BackgroundServices();
    await services.downloadBest(1);
    const tasks = (await services.downloads()).list();
    expect(tasks.map((task) => task.kind).sort()).toEqual(['audio', 'video']);
  });

  it('a separate audio track is saved as an audio file', () => {
    const { request, view } = createTask({
      taskId: 't',
      candidate: splitStream(),
      variant: dashAudio('a128', 128_000),
      settings: DEFAULT_SETTINGS,
      now: 0,
    });
    expect(request.kind).toBe('audio');
    expect(view.kind).toBe('audio');
    expect(view.filename).toMatch(/\.m4a$/);
  });

  it('D21: the manager refuses what the scan said cannot be saved', () => {
    __setBrowserApi(createFakeBrowserApi() as BrowserApi);
    const manager = new DownloadManager(DEFAULT_SETTINGS);
    const tooLarge = { ...dashVideo(2160, 40_000_000), saveability: 'too-large' as const };
    expect(() => manager.enqueue(splitStream(), tooLarge)).toThrow(
      expect.objectContaining({ code: ErrorCode.DISK_ERROR }),
    );
    expect(() => manager.enqueue({ ...splitStream(), saveability: 'encrypted' })).toThrow(
      expect.objectContaining({ code: ErrorCode.UNSUPPORTED_MANIFEST }),
    );
    expect(manager.list()).toHaveLength(0);
  });
});
