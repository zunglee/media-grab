/**
 * A PopupBridge that answers from fixtures, so each popup in the harness runs
 * the real PopupController - start-up, permissions, scans, downloads - instead
 * of being handed a finished state. That is what lets the UI tests catch a bug
 * in what the popup does, not only in how it looks.
 *
 * A download started here is queued the way the worker would report it: a new
 * row in the download list, named by the real naming rule, broadcast to the
 * popup as DOWNLOADS_STATE. So a UI test can see what a click queued - "Best
 * download" on a split stream queues two files.
 */
import { DownloadState, type DownloadTaskView } from '../../core/download-types.ts';
import type { MediaCandidate, MediaVariant, ScanResult } from '../../core/types.ts';
import { filenameFor, strategyFor } from '../../downloads/task-factory.ts';
import { DEFAULT_SETTINGS } from '../../storage/settings.ts';
import type { BackgroundMessage, PopupBridge } from '../lib/bridge.ts';
import { copyToClipboard } from '../lib/diagnostics.ts';

export interface FixtureOptions {
  /** The worker's last scan when the popup opens. */
  stored?: ScanResult;
  /** What each scan request returns, in order; the last one repeats. Undefined = no answer. */
  scans?: Array<ScanResult | undefined>;
  downloads?: DownloadTaskView[];
  /** Whether the site is granted when the popup opens. A request is always granted. */
  granted?: boolean;
}

const TAB = { id: 1, url: 'https://example.test/talks/how-to-build-a-startup', title: 'Harness' };

export function fixtureBridge(options: FixtureOptions): PopupBridge {
  const scans = [...(options.scans ?? [options.stored])];
  let granted = options.granted ?? true;
  let shown = options.stored;
  let downloads = [...(options.downloads ?? [])];
  const listeners = new Set<(message: BackgroundMessage) => void>();

  return {
    currentTab: async () => TAB,
    getScan: async () => options.stored,
    requestScan: async () => {
      const next = scans.length > 1 ? scans.shift() : scans[0];
      shown = next ?? shown;
      return next;
    },
    getDownloads: async () => downloads,
    startDownload: async (_tabId, candidateId, variantId) => {
      const candidate = shown?.candidates.find((entry) => entry.id === candidateId);
      if (!candidate) return { ok: false, error: 'That media is no longer in the current scan.' };
      const offered = [...(candidate.variants ?? []), ...(candidate.audioTracks ?? [])];
      const variant = offered.find((entry) => entry.id === variantId);
      const task = queued(`harness-${downloads.length + 1}`, candidate, variant);
      downloads = [task, ...downloads];
      for (const listener of listeners) listener({ type: 'DOWNLOADS_STATE', tasks: downloads });
      return { ok: true, taskId: task.id };
    },
    sendDownloadCommand: async () => undefined,
    onBackgroundMessage: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    loadSettings: async () => structuredClone(DEFAULT_SETTINGS),
    hasSiteAccess: async () => granted,
    requestSiteAccess: async () => {
      granted = true;
      return true;
    },
    requestHostAccess: async () => true,
    extensionVersion: () => '0.0.0-harness',
    copyToClipboard,
    openOptions: () => undefined,
  };
}

/** A download as the worker lists it the moment it is queued. */
function queued(
  id: string,
  candidate: MediaCandidate,
  variant: MediaVariant | undefined,
): DownloadTaskView {
  const strategy = strategyFor(candidate, variant);
  return {
    id,
    filename: filenameFor({ candidate, variant, settings: DEFAULT_SETTINGS }),
    url: variant?.url ?? candidate.url,
    pageUrl: candidate.pageUrl,
    state: DownloadState.QUEUED,
    strategy,
    pausable: strategy === 'browser-download',
    kind: variant?.kind ?? candidate.kind,
    progress: { receivedBytes: 0, speedBps: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attempts: 0,
  };
}
