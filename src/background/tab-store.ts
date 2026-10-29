/**
 * What the worker knows about each tab.
 *
 * Kept in `storage.session`, not in memory: a Chrome MV3 service worker is
 * killed between a page load and the user opening the popup often enough that
 * in-memory state would regularly come back empty. Two records per tab:
 *
 *   ctx:<tabId>   the page as its content scripts described it (TabContext)
 *   scan:<tabId>  the last ScanResult, which is what the popup renders
 *
 * Every read-modify-write of a tab's context runs one at a time for that tab.
 * Reports from several frames arrive concurrently, and without that ordering
 * two of them could each read the old context and the second write would
 * silently erase the first.
 *
 * Session storage has one quota for every tab and the download queue, and a
 * write that would pass it is refused - so one tab holding too much breaks
 * detection in every other tab. Each report is capped (core/messages.ts), but
 * a page with many frames multiplies that cap, so each record also has a byte
 * budget (core/limits.ts `MAX_TAB_CONTEXT_BYTES`, `MAX_TAB_SCAN_BYTES`).
 * Over it, the least valuable data goes first and the page's identity never
 * does (`fitContext`, `fitScan`).
 */
import type { StorageArea } from '../browser/api.ts';
import {
  MAX_CANDIDATES_PER_TAB,
  MAX_TAB_CONTEXT_BYTES,
  MAX_TAB_SCAN_BYTES,
} from '../core/limits.ts';
import { createLogger } from '../core/log.ts';
import type { PageReport } from '../core/messages.ts';
import type { DetectionSource, MediaCandidate, PageSignals, ScanResult } from '../core/types.ts';
import { merge } from '../media/dedupe.ts';

const log = createLogger('tabs');

export const TOP_FRAME = 0;

/**
 * The `signalsByFrame` key that holds sub-frames' signals folded together when
 * the context is over its budget (see `fitContext`).
 */
export const FOLDED_FRAMES = 'folded';

/** A frame's report once the worker has rebuilt its claims into candidates. */
export type FrameReport = Omit<PageReport, 'candidates'> & { candidates: MediaCandidate[] };

export interface TabContext {
  /** The top-level page. Only the top frame may set these. */
  pageUrl: string;
  pageTitle: string;
  pagePoster?: string;
  /** The top frame's `routeStartedAt`; 0 before its first report. */
  routeStartedAt: number;
  /**
   * Each frame's signals, by frame id; `tabSignals` sums them. Over the byte
   * budget, sub-frames' entries are folded into one under FOLDED_FRAMES.
   */
  signalsByFrame: Record<string, PageSignals>;
  /** DOM and page-hook candidates from every frame, each tagged with its frame. */
  pageCandidates: MediaCandidate[];
}

export const EMPTY_CONTEXT: TabContext = {
  pageUrl: '',
  pageTitle: '',
  routeStartedAt: 0,
  signalsByFrame: {},
  pageCandidates: [],
};

/**
 * The tab as a whole. Any frame's MediaSource or MediaKeys counts - the player
 * may well live in an iframe - and counts add up across frames.
 */
export function tabSignals(context: TabContext): PageSignals {
  return sumSignals(Object.values(context.signalsByFrame));
}

function sumSignals(all: PageSignals[]): PageSignals {
  return {
    hasMediaSource: all.some((signals) => signals.hasMediaSource),
    hasMediaKeys: all.some((signals) => signals.hasMediaKeys),
    mediaElements: all.reduce((sum, signals) => sum + signals.mediaElements, 0),
    playerFrames: all.reduce((sum, signals) => sum + signals.playerFrames, 0),
  };
}

/**
 * Fold one frame's report into the tab's context. Pure, so the rules below are
 * unit-tested directly:
 *
 *  1. Only the top frame says which page the tab is on. A top-frame report
 *     whose `routeStartedAt` differs from the last one is a navigation, and
 *     everything learned about the previous page is dropped. The URL is not
 *     compared: a fragment change or a replaceState tidying the address keeps
 *     the page, and a back-forward-cache restore of the same URL does not.
 *  2. A sub-frame adds candidates and signals. It never changes the page URL or
 *     title - an embedded player or an ad frame is not a navigation.
 *  3. A report is that frame's complete state, so it replaces the frame's
 *     earlier candidates and signals instead of piling up next to them.
 *  4. The result fits the tab's byte budget (`fitContext`).
 */
export function applyReport(
  previous: TabContext,
  frameId: number,
  report: FrameReport,
): { context: TabContext; navigated: boolean } {
  const isTop = frameId === TOP_FRAME;
  const navigated =
    isTop && previous.routeStartedAt !== 0 && report.routeStartedAt !== previous.routeStartedAt;
  const base = navigated ? EMPTY_CONTEXT : previous;

  const byId = new Map<string, MediaCandidate>();
  for (const candidate of base.pageCandidates) {
    if (candidate.frameId !== frameId) byId.set(candidate.id, candidate);
  }
  // One URL can be claimed twice in a report - a played <video> and the
  // request it made. Merge them (the element knows the title and poster),
  // rather than letting whichever came last erase the other.
  const fromReport = new Map<string, MediaCandidate>();
  for (const candidate of report.candidates) {
    const earlier = fromReport.get(candidate.id);
    fromReport.set(candidate.id, earlier ? merge(earlier, candidate) : candidate);
  }
  for (const candidate of fromReport.values()) byId.set(candidate.id, { ...candidate, frameId });

  const context: TabContext = {
    ...base,
    signalsByFrame: { ...base.signalsByFrame, [frameId]: report.signals },
    // The reporting frame's candidates were added last, so a tab over its cap
    // loses other frames' oldest entries, never the report just received.
    pageCandidates: [...byId.values()].slice(-MAX_CANDIDATES_PER_TAB),
  };

  if (isTop) {
    context.pageUrl = report.pageUrl;
    context.pageTitle = report.pageTitle;
    context.routeStartedAt = report.routeStartedAt;
    if (report.pagePoster) context.pagePoster = report.pagePoster;
  }

  return { context: fitContext(context), navigated };
}

/**
 * How much a claim is worth keeping, by where the page found it - the order a
 * content script puts a report in (content/index.ts `reportOrder`), where the
 * per-frame caps cut from the end: links and metadata go first (a page can
 * have thousands), then what the page fetched (the manifests), and media
 * elements last (they carry the titles, posters and subtitles).
 */
const KEEP_PRIORITY: Record<DetectionSource, number> = {
  'dom-attribute': 0,
  'page-hook': 1,
  network: 1,
  adapter: 1,
  'dom-element': 2,
};

/**
 * The context as it may be stored: within `budget` bytes of UTF-8 JSON.
 * Under the budget - every real page - it is returned untouched. Over it,
 * data is dropped in this order until it fits:
 *
 *  1. Sub-frames' candidates. Least valuable first (KEEP_PRIORITY), so an ad
 *     frame's links go before an embedded player's manifest; within one
 *     priority, the frame that reported longest ago first (the report just
 *     received last, as the count cap above does); within one report, from
 *     its end.
 *  2. Sub-frames' signals, folded into one FOLDED_FRAMES entry. The tab's
 *     totals (`tabSignals`) are unchanged, so an iframe player's MediaKeys
 *     still reads as DRM. A folded frame that reports again adds its own
 *     entry beside the fold: its flags stay set and its counts count twice
 *     until the next navigation - conservative, and counts are advisory.
 *  3. The top frame's candidates, in the same order.
 *
 * Never dropped: the page's identity (URL, title, poster, route start) and the
 * top frame's signals. Each is capped on arrival, so together they always fit.
 */
export function fitContext(context: TabContext, budget = MAX_TAB_CONTEXT_BYTES): TabContext {
  let size = jsonBytes(context);
  if (size <= budget) return context;

  const candidates = context.pageCandidates;
  const kept = candidates.map(() => true);
  let remaining = candidates.length;
  const isTop = (candidate: MediaCandidate) => (candidate.frameId ?? TOP_FRAME) === TOP_FRAME;
  const dropUntilFits = (order: number[]) => {
    for (const index of order) {
      if (size <= budget) return;
      kept[index] = false;
      size -= jsonBytes(candidates[index]) + (remaining > 1 ? 1 : 0); // and its comma
      remaining -= 1;
    }
  };

  dropUntilFits(dropOrder(candidates, (candidate) => !isTop(candidate)));
  let signalsByFrame = context.signalsByFrame;
  if (size > budget) {
    signalsByFrame = foldSubFrameSignals(signalsByFrame);
    size = jsonBytes({ ...context, signalsByFrame, pageCandidates: keptOnly(candidates, kept) });
  }
  dropUntilFits(dropOrder(candidates, isTop));

  const pageCandidates = keptOnly(candidates, kept);
  log.debug(
    `tab context over its ${budget}-byte budget: kept ${pageCandidates.length} of ${candidates.length} candidates`,
  );
  return { ...context, signalsByFrame, pageCandidates };
}

/** Indexes of the candidates `include` selects, least worth keeping first. */
function dropOrder(
  candidates: MediaCandidate[],
  include: (candidate: MediaCandidate) => boolean,
): number[] {
  // A frame's candidates sit together, added when it last reported (applyReport),
  // so where a frame's first one sits says how long ago it reported.
  const reportedAt = new Map<number | undefined, number>();
  candidates.forEach((candidate, index) => {
    if (!reportedAt.has(candidate.frameId)) reportedAt.set(candidate.frameId, index);
  });
  const order: number[] = [];
  candidates.forEach((candidate, index) => {
    if (include(candidate)) order.push(index);
  });
  const priority = (index: number) => KEEP_PRIORITY[candidates[index]?.source ?? 'dom-element'];
  const age = (index: number) => reportedAt.get(candidates[index]?.frameId) ?? 0;
  return order.sort((a, b) => priority(a) - priority(b) || age(a) - age(b) || b - a);
}

function keptOnly(candidates: MediaCandidate[], kept: boolean[]): MediaCandidate[] {
  return candidates.filter((_candidate, index) => kept[index]);
}

function foldSubFrameSignals(
  signalsByFrame: Record<string, PageSignals>,
): Record<string, PageSignals> {
  const top = signalsByFrame[TOP_FRAME];
  const others = Object.entries(signalsByFrame)
    .filter(([frame]) => frame !== String(TOP_FRAME))
    .map(([, signals]) => signals);
  return {
    ...(top ? { [TOP_FRAME]: top } : {}),
    ...(others.length > 0 ? { [FOLDED_FRAMES]: sumSignals(others) } : {}),
  };
}

/**
 * The scan as it may be stored: within `budget` bytes of UTF-8 JSON. The scan
 * is built from the context (already within its budget) plus the network
 * observer's candidates and the manifests' renditions, which a page can also
 * inflate. Over the budget, the debug-only list of rejected URLs goes first,
 * then candidates from the lowest-ranked up (the engine ranks best first).
 * The page, the stats and the diagnosis are never dropped.
 */
export function fitScan(result: ScanResult, budget = MAX_TAB_SCAN_BYTES): ScanResult {
  let size = jsonBytes(result);
  if (size <= budget) return result;

  const rejected = [...result.rejected];
  const candidates = [...result.candidates];
  for (const list of [rejected, candidates] as unknown[][]) {
    while (size > budget && list.length > 0) {
      size -= jsonBytes(list.pop()) + (list.length > 0 ? 1 : 0); // and its comma
    }
  }
  log.debug(
    `scan over its ${budget}-byte budget: kept ${candidates.length} of ${result.candidates.length} candidates`,
  );
  return { ...result, candidates, rejected };
}

/**
 * Bytes of `value` as UTF-8 JSON - what a storage write serialises. Counted
 * without building the encoded copy: a context near its budget is hundreds of
 * KB, measured on every report.
 */
export function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value) ?? '';
  let bytes = json.length;
  for (let i = 0; i < json.length; i += 1) {
    const unit = json.charCodeAt(i);
    // One UTF-16 unit is 1 byte of UTF-8 below U+0080, 2 below U+0800, 3 above;
    // a surrogate pair (two units) is 4, so each half counts 2.
    if (unit >= 0x80) bytes += unit < 0x800 || (unit >= 0xd800 && unit <= 0xdfff) ? 1 : 2;
  }
  return bytes;
}

export class TabStore {
  private readonly queues = new Map<number, Promise<unknown>>();
  /** Tabs that have closed. Chrome and Firefox never reuse a tab id in a session. */
  private readonly closed = new Set<number>();

  constructor(private readonly storage: StorageArea) {}

  async context(tabId: number): Promise<TabContext> {
    const stored = await this.storage.get<Partial<TabContext>>(contextKey(tabId));
    return { ...EMPTY_CONTEXT, ...stored };
  }

  applyReport(
    tabId: number,
    frameId: number,
    report: FrameReport,
  ): Promise<{ context: TabContext; navigated: boolean }> {
    return this.oneAtATime(tabId, async () => {
      const outcome = applyReport(await this.context(tabId), frameId, report);
      await this.storage.set(contextKey(tabId), outcome.context);
      return outcome;
    });
  }

  lastScan(tabId: number): Promise<ScanResult | undefined> {
    return this.storage.get<ScanResult>(scanKey(tabId));
  }

  /**
   * Stores the scan within its budget and returns what was stored, which is
   * what the popup should be shown: a download is started from the stored
   * scan, so a row it lacks could not be downloaded. A scan that finishes
   * after its tab closed is dropped, not stored.
   */
  async saveScan(tabId: number, result: ScanResult): Promise<ScanResult> {
    const stored = fitScan(result);
    if (this.closed.has(tabId)) return stored;
    await this.storage.set(scanKey(tabId), stored);
    return stored;
  }

  /**
   * Per-tab state is worthless once the tab is gone. Queued behind any report
   * still in flight, so that report cannot write the record back afterwards.
   */
  forget(tabId: number): Promise<void> {
    this.closed.add(tabId);
    return this.oneAtATime(tabId, async () => {
      await Promise.all([
        this.storage.remove(contextKey(tabId)),
        this.storage.remove(scanKey(tabId)),
      ]);
    });
  }

  /** Run `work` after every earlier update for the same tab has settled. */
  private oneAtATime<T>(tabId: number, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(tabId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.queues.set(tabId, next);
    const release = () => {
      if (this.queues.get(tabId) === next) this.queues.delete(tabId);
    };
    next.then(release, release);
    return next;
  }
}

function contextKey(tabId: number): string {
  return `ctx:${tabId}`;
}

/** Read by the extension tests too; keep the shape `scan:<tabId>`. */
function scanKey(tabId: number): string {
  return `scan:${tabId}`;
}
