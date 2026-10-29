/**
 * What the popup does on open and on each click, driven through a fake bridge.
 * Tests marked "regression" pin bugs the popup shipped with while this logic
 * lived inside Popup.svelte, where the harness never ran it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DownloadTaskView } from '../../src/core/download-types.ts';
import { DownloadState } from '../../src/core/download-types.ts';
import type { MediaCandidate, ScanResult } from '../../src/core/types.ts';
import { DEFAULT_SETTINGS } from '../../src/storage/settings.ts';
import type { BackgroundMessage, PopupBridge } from '../../src/ui/lib/bridge.ts';
import { NOTICES, PopupController } from '../../src/ui/lib/popup-controller.ts';

const PAGE = 'https://video.example/watch';

function candidate(overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return {
    id: 'c1',
    url: 'https://cdn.example/feature.mp4',
    pageUrl: PAGE,
    kind: 'video',
    protocol: 'progressive',
    format: 'mp4',
    source: 'network',
    seenAt: 1,
    tracks: { video: true, audio: true },
    ...overrides,
  };
}

function scan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    tabId: 7,
    pageUrl: PAGE,
    pageTitle: 'Watch',
    scannedAt: 1_000,
    candidates: [candidate()],
    rejected: [],
    stats: {
      networkRequestsObserved: 0,
      mediaElements: 1,
      candidatesRaw: 1,
      candidatesAfterDedupe: 1,
      manifestsParsed: 0,
      byProtocol: { progressive: 1, hls: 0, dash: 0, blob: 0, data: 0, unknown: 0 },
      parseErrors: 0,
    },
    ...overrides,
  };
}

function task(id: string, state: DownloadTaskView['state']): DownloadTaskView {
  return {
    id,
    filename: `${id}.mp4`,
    url: 'https://cdn.example/feature.mp4',
    pageUrl: PAGE,
    state,
    strategy: 'browser-download',
    pausable: true,
    kind: 'video',
    progress: { receivedBytes: 0, speedBps: 0 },
    createdAt: 1,
    updatedAt: 1,
    attempts: 1,
  };
}

/** A promise the test resolves by hand, to hold the popup mid-start-up. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A bridge with sensible answers; each test overrides what it is about. */
function fakeBridge(overrides: Partial<PopupBridge> = {}) {
  const listeners = new Set<(message: BackgroundMessage) => void>();
  const calls: string[] = [];
  const bridge: PopupBridge = {
    currentTab: vi.fn(async () => ({ id: 7, url: PAGE, title: 'Watch' })),
    getScan: vi.fn(async () => undefined),
    requestScan: vi.fn(async () => scan()),
    getDownloads: vi.fn(async () => []),
    startDownload: vi.fn(async () => ({ ok: true, taskId: 't1' })),
    sendDownloadCommand: vi.fn(async () => undefined),
    onBackgroundMessage: vi.fn((handler) => {
      calls.push('subscribe');
      listeners.add(handler);
      return () => listeners.delete(handler);
    }),
    loadSettings: vi.fn(async () => {
      calls.push('loadSettings');
      return structuredClone(DEFAULT_SETTINGS);
    }),
    hasSiteAccess: vi.fn(async () => true),
    requestSiteAccess: vi.fn(async () => true),
    requestHostAccess: vi.fn(async () => true),
    extensionVersion: () => '9.8.7',
    copyToClipboard: vi.fn(async () => true),
    openOptions: vi.fn(),
    ...overrides,
  };
  const broadcast = (message: BackgroundMessage) => {
    for (const listener of listeners) listener(message);
  };
  return { bridge, broadcast, calls, listeners };
}

function open(bridge: PopupBridge): PopupController {
  return new PopupController(bridge, () => undefined);
}

describe('opening the popup', () => {
  it('shows the stored scan without scanning again', async () => {
    const { bridge } = fakeBridge({ getScan: vi.fn(async () => scan()) });
    const controller = open(bridge);
    await controller.start();

    expect(controller.state.scan?.candidates).toHaveLength(1);
    expect(controller.state.access).toBe('granted');
    expect(controller.state.scanStatus).toBe('idle');
    expect(bridge.requestScan).not.toHaveBeenCalled();
  });

  it('scans when there is no stored scan and the site is granted', async () => {
    const { bridge } = fakeBridge();
    const controller = open(bridge);
    await controller.start();
    expect(bridge.requestScan).toHaveBeenCalledWith(7);
    expect(controller.state.scan).toBeDefined();
  });

  it('asks for access instead of scanning when the site is not granted', async () => {
    const { bridge } = fakeBridge({ hasSiteAccess: vi.fn(async () => false) });
    const controller = open(bridge);
    await controller.start();
    expect(controller.state.access).toBe('needed');
    expect(bridge.requestScan).not.toHaveBeenCalled();
  });

  it('marks pages no extension may read as unsupported', async () => {
    const { bridge } = fakeBridge({
      currentTab: vi.fn(async () => ({ id: 7, url: 'chrome://settings', title: '' })),
    });
    const controller = open(bridge);
    await controller.start();
    expect(controller.state.access).toBe('unsupported');
  });

  it('regression C17: subscribes before asking for anything', async () => {
    const { bridge, calls } = fakeBridge();
    await open(bridge).start();
    expect(calls[0]).toBe('subscribe');
  });

  it('regression C17: keeps a DOWNLOADS_STATE broadcast sent while the first scan runs', async () => {
    const pending = deferred<ScanResult | undefined>();
    const { bridge, broadcast } = fakeBridge({ requestScan: vi.fn(() => pending.promise) });
    const controller = open(bridge);
    const started = controller.start();
    await vi.waitFor(() => expect(bridge.requestScan).toHaveBeenCalled());

    broadcast({ type: 'DOWNLOADS_STATE', tasks: [task('t9', DownloadState.DOWNLOADING)] });
    pending.resolve(scan());
    await started;

    expect(controller.state.downloads.map((entry) => entry.id)).toEqual(['t9']);
  });

  it('regression C17: a failed scan ends idle with no scan, and "Scan again" retries', async () => {
    const requestScan = vi
      .fn<PopupBridge['requestScan']>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(scan());
    const { bridge } = fakeBridge({ requestScan });
    const controller = open(bridge);
    await controller.start();
    expect(controller.state.scanStatus).toBe('idle');
    expect(controller.state.scan).toBeUndefined();

    await controller.rescan();
    expect(controller.state.scan?.candidates).toHaveLength(1);
  });

  it('regression C17: with no tab it ends idle, and "Scan again" looks for the tab again', async () => {
    const currentTab = vi
      .fn<PopupBridge['currentTab']>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 7, url: PAGE, title: 'Watch' });
    const { bridge } = fakeBridge({ currentTab });
    const controller = open(bridge);
    await controller.start();
    expect(controller.state.scanStatus).toBe('idle');
    expect(controller.state.tabId).toBeUndefined();

    await controller.rescan();
    expect(controller.state.tabId).toBe(7);
    expect(controller.state.scan).toBeDefined();
  });

  it('never replaces a newer scan with an older reply', async () => {
    const reply = deferred<ScanResult | undefined>();
    const { bridge, broadcast } = fakeBridge({ getScan: vi.fn(() => reply.promise) });
    const controller = open(bridge);
    const started = controller.start();
    await vi.waitFor(() => expect(bridge.getScan).toHaveBeenCalled());

    broadcast({ type: 'SCAN_RESULT', result: scan({ scannedAt: 2_000 }) });
    reply.resolve(scan({ scannedAt: 1_000 }));
    await started;

    expect(controller.state.scan?.scannedAt).toBe(2_000);
  });

  it('ignores scans of other tabs, and stops listening when closed', async () => {
    const { bridge, broadcast, listeners } = fakeBridge({ getScan: vi.fn(async () => scan()) });
    const controller = open(bridge);
    await controller.start();

    broadcast({ type: 'SCAN_RESULT', result: scan({ tabId: 8, scannedAt: 5_000 }) });
    expect(controller.state.scan?.tabId).toBe(7);

    controller.stop();
    expect(listeners.size).toBe(0);
  });
});

describe('granting access from the popup', () => {
  it('regression C2: the "reload the page" notice survives the scan that follows the grant', async () => {
    const { bridge } = fakeBridge({ hasSiteAccess: vi.fn(async () => false) });
    const controller = open(bridge);
    await controller.start();

    await controller.grantAccess();
    expect(controller.state.access).toBe('granted');
    expect(bridge.requestScan).toHaveBeenCalled();
    expect(controller.state.notice).toBe(NOTICES.reloadAfterGrant);
  });

  it('asks the browser in the same tick as the click, before any await', async () => {
    const { bridge } = fakeBridge({ hasSiteAccess: vi.fn(async () => false) });
    const controller = open(bridge);
    await controller.start();

    void controller.grantAccess();
    expect(bridge.requestSiteAccess).toHaveBeenCalledWith(PAGE);
  });

  it('says so when the user declines', async () => {
    const { bridge } = fakeBridge({
      hasSiteAccess: vi.fn(async () => false),
      requestSiteAccess: vi.fn(async () => false),
    });
    const controller = open(bridge);
    await controller.start();

    await controller.grantAccess();
    expect(controller.state.access).toBe('needed');
    expect(controller.state.notice).toBe(NOTICES.accessDeclined);
  });
});

describe('"Allow ‹host› and retry" on a failed download (D18)', () => {
  it('asks for the host from the click, then retries the task', async () => {
    const { bridge } = fakeBridge();
    const controller = open(bridge);
    await controller.start();

    const click = controller.allowHostAndRetry('t1', 'cdn.example');
    expect(bridge.requestHostAccess).toHaveBeenCalledWith('cdn.example');
    await click;
    expect(bridge.sendDownloadCommand).toHaveBeenCalledWith('t1', 'retry');
  });

  it('does not retry, and says why, when the user declines', async () => {
    const { bridge } = fakeBridge({ requestHostAccess: vi.fn(async () => false) });
    const controller = open(bridge);
    await controller.start();

    await controller.allowHostAndRetry('t1', 'cdn.example');
    expect(bridge.sendDownloadCommand).not.toHaveBeenCalled();
    expect(controller.state.notice).toBe(NOTICES.hostDeclined);
  });
});

describe('downloads from the popup', () => {
  it('switches to the Downloads view once a download starts', async () => {
    const { bridge } = fakeBridge({ getScan: vi.fn(async () => scan()) });
    const controller = open(bridge);
    await controller.start();

    await controller.downloadBest();
    expect(bridge.startDownload).toHaveBeenCalledWith(7, 'c1', undefined);
    expect(controller.state.view).toBe('downloads');
    expect(controller.state.busy).toBe(false);
  });

  it("shows the worker's reason when a download cannot start", async () => {
    const { bridge } = fakeBridge({
      getScan: vi.fn(async () => scan()),
      startDownload: vi.fn(async () => ({ ok: false, error: 'Scan the page again.' })),
    });
    const controller = open(bridge);
    await controller.start();

    await controller.download(candidate());
    expect(controller.state.view).toBe('media');
    expect(controller.state.notice).toBe('Scan the page again.');
  });

  it('regression C18: "Best download" starts nothing when every candidate is protected', async () => {
    const { bridge } = fakeBridge({
      getScan: vi.fn(async () => scan({ candidates: [candidate({ drm: true })] })),
    });
    const controller = open(bridge);
    await controller.start();

    await controller.downloadBest();
    expect(bridge.startDownload).not.toHaveBeenCalled();
  });

  it('refreshes the list after a command', async () => {
    const getDownloads = vi
      .fn<PopupBridge['getDownloads']>()
      .mockResolvedValueOnce([task('t1', DownloadState.DOWNLOADING)])
      .mockResolvedValueOnce([task('t1', DownloadState.PAUSED)]);
    const { bridge } = fakeBridge({ getScan: vi.fn(async () => scan()), getDownloads });
    const controller = open(bridge);
    await controller.start();

    await controller.command('t1', 'pause');
    expect(bridge.sendDownloadCommand).toHaveBeenCalledWith('t1', 'pause');
    expect(controller.state.downloads[0]?.state).toBe(DownloadState.PAUSED);
  });
});

describe('the diagnostic report', () => {
  it('regression C16: carries the version the browser reports, not a hard-coded one', async () => {
    const { bridge } = fakeBridge({ getScan: vi.fn(async () => scan()) });
    const controller = open(bridge);
    await controller.start();

    await controller.copyReport();
    const copied = vi.mocked(bridge.copyToClipboard).mock.calls[0]?.[0] ?? '';
    expect(JSON.parse(copied).extensionVersion).toBe('9.8.7');
    expect(controller.state.notice).toBe(NOTICES.reportCopied);
  });
});

describe('settings', () => {
  it('turns on power mode when the user chose it', async () => {
    const { bridge } = fakeBridge({
      loadSettings: vi.fn(async () => ({
        ...DEFAULT_SETTINGS,
        general: { ...DEFAULT_SETTINGS.general, mode: 'power' as const },
      })),
    });
    const controller = open(bridge);
    await controller.start();
    expect(controller.state.powerMode).toBe(true);
  });
});
