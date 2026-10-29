/**
 * Turns what the worker knows about a tab into a ScanResult.
 *
 *   TabStore (DOM, page signals) ─┐
 *                                 ├─> runScan ─> saveScan ─> badge ─> SCAN_RESULT
 *   NetworkObserver ──────────────┘                                  to open popups
 *
 * Scans are expensive - each may fetch up to MAX_MANIFEST_EXPANSIONS manifests
 * (core/limits.ts) - and a busy
 * page triggers them in bursts (every report, every media request). So there
 * is at most one scan per tab in flight, and manifests fetched in the last
 * half minute are reused (detection/manifest-cache.ts). A request that arrives while one is
 * running waits for ONE follow-up scan, shared with every other request that
 * arrived meanwhile; that follow-up starts after the current one and therefore
 * sees whatever prompted the request. A caller that knows when its data was
 * stored can pass `notBefore`: a scan that started after that already sees it,
 * so the caller joins it instead of queueing another.
 *
 * Times are `performance.now()` in this worker.
 */
import { browserApi } from '../browser/index.ts';
import type { ScanResult } from '../core/types.ts';
import { runScan } from '../detection/engine.ts';
import { ManifestCache } from '../detection/manifest-cache.ts';
import type { NetworkObserver } from '../detection/network.ts';
import { setDetectionBadge } from './badge.ts';
import { type TabStore, tabSignals } from './tab-store.ts';

interface Flight {
  current: Promise<ScanResult>;
  startedAt: number;
  followUp?: Promise<ScanResult>;
}

export class Scanner {
  private readonly flights = new Map<number, Flight>();
  private readonly manifests = new ManifestCache();

  constructor(
    private readonly tabs: TabStore,
    private readonly network: NetworkObserver,
  ) {}

  scan(tabId: number, options: { notBefore?: number } = {}): Promise<ScanResult> {
    const flight = this.flights.get(tabId);
    if (!flight) return this.launch(tabId);
    if (options.notBefore !== undefined && flight.startedAt >= options.notBefore) {
      return flight.current;
    }
    flight.followUp ??= flight.current.then(
      () => this.launch(tabId),
      () => this.launch(tabId),
    );
    return flight.followUp;
  }

  private launch(tabId: number): Promise<ScanResult> {
    const flight: Flight = { current: this.scanNow(tabId), startedAt: performance.now() };
    this.flights.set(tabId, flight);
    const land = () => {
      // A queued follow-up replaces this flight when it launches.
      if (this.flights.get(tabId) === flight && !flight.followUp) this.flights.delete(tabId);
    };
    flight.current.then(land, land);
    return flight.current;
  }

  private async scanNow(tabId: number): Promise<ScanResult> {
    const context = await this.tabs.context(tabId);
    // Before the first report arrives, the browser's own tab record is all we have.
    const tab = context.pageUrl ? undefined : await browserApi().tabs.get(tabId);
    const pageUrl = context.pageUrl || tab?.url || '';
    const pageTitle = context.pageTitle || tab?.title || '';

    const result = await runScan({
      tabId,
      pageUrl,
      pageTitle,
      pageCandidates: context.pageCandidates,
      networkCandidates: this.network.candidatesFor(tabId),
      signals: tabSignals(context),
      requestsObserved: this.network.requestsObserved(tabId),
      ...(context.pagePoster ? { pagePoster: context.pagePoster } : {}),
      manifests: this.manifests,
    });

    // What was stored can be less than the scan: a hostile page is trimmed to
    // the tab's storage budget (tab-store.ts). Show only what can be started.
    const stored = await this.tabs.saveScan(tabId, result);
    await setDetectionBadge(tabId, stored.candidates.length);
    // Once per scan, however many callers share it. The popup ignores other tabs.
    await browserApi().runtime.sendMessage({ type: 'SCAN_RESULT', result: stored });
    return stored;
  }
}
