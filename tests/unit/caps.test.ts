/**
 * W8: the per-tab byte budget in session storage.
 *
 * Every report is capped on arrival, but a page with many frames multiplies
 * those caps, and session storage is one quota for every tab. These tests
 * drive the fold the way the worker does - wire message, parseMessage,
 * candidateFromReport, applyReport - so the per-report caps are the real ones.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyReport,
  EMPTY_CONTEXT,
  FOLDED_FRAMES,
  type FrameReport,
  fitContext,
  fitScan,
  jsonBytes,
  type TabContext,
  TabStore,
  tabSignals,
} from '../../src/background/tab-store.ts';
import { __setBrowserApi } from '../../src/browser/index.ts';
import {
  MAX_TAB_CONTEXT_BYTES,
  MAX_TAB_SCAN_BYTES,
  MAX_TAB_SESSION_BYTES,
  MAX_URL_LENGTH,
} from '../../src/core/limits.ts';
import { parseMessage, type ReportedCandidate } from '../../src/core/messages.ts';
import type {
  DetectionSource,
  MediaCandidate,
  PageSignals,
  ScanResult,
} from '../../src/core/types.ts';
import { candidateFromReport, makeCandidate } from '../../src/detection/candidate.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';

const PAGE = 'https://site.example/watch/1';
const LOADED_AT = 1_000_000;

function signals(overrides: Partial<PageSignals> = {}): PageSignals {
  return {
    hasMediaSource: false,
    hasMediaKeys: false,
    mediaElements: 0,
    playerFrames: 0,
    ...overrides,
  };
}

/**
 * What the worker does with a PAGE_REPORT: validate it (the per-report caps
 * apply here) and rebuild each claim into a candidate.
 */
function received(
  frameId: number,
  wire: { pageUrl: string; claims: ReportedCandidate[]; signals?: PageSignals; poster?: string },
): FrameReport {
  const parsed = parseMessage({
    type: 'PAGE_REPORT',
    pageUrl: wire.pageUrl,
    pageTitle: `Frame ${frameId}`,
    routeStartedAt: LOADED_AT,
    signals: wire.signals ?? signals(),
    ...(wire.poster ? { pagePoster: wire.poster } : {}),
    candidates: wire.claims,
  });
  if (parsed?.type !== 'PAGE_REPORT') throw new Error('report refused');
  const { type: _type, ...report } = parsed;
  const origin = { pageUrl: report.pageUrl, pageTitle: report.pageTitle, frameId };
  return {
    ...report,
    candidates: report.candidates.map((claim) => candidateFromReport(claim, origin)),
  };
}

function candidate(url: string, source: DetectionSource, frameId: number): MediaCandidate {
  return { ...makeCandidate({ url, pageUrl: PAGE, kind: 'video', source }), frameId };
}

afterEach(() => {
  __setBrowserApi(null);
});

describe('W8: the per-tab budget', () => {
  it('W8: is derived from the session quota: 16 tabs at their full budget use half of it', () => {
    const quota = 10_485_760; // chrome.storage.session.QUOTA_BYTES
    expect(MAX_TAB_SESSION_BYTES * 16).toBeLessThanOrEqual(quota / 2);
    expect(MAX_TAB_CONTEXT_BYTES + MAX_TAB_SCAN_BYTES).toBe(MAX_TAB_SESSION_BYTES);
  });

  it('W8: a real page - a player, its manifest and 200 video links - is left untouched', () => {
    const claims: ReportedCandidate[] = [
      {
        url: 'https://cdn.site.example/v/81723/master.m3u8',
        kind: 'video',
        source: 'dom-element',
        title: 'An ordinary video title of ordinary length',
        posterUrl: 'https://img.site.example/v/81723/poster.jpg',
      },
      { url: 'https://cdn.site.example/v/81723/720p.m3u8', kind: 'video', source: 'page-hook' },
      ...Array.from({ length: 198 }, (_unused, i) => ({
        url: `https://site.example/videos/${10_000 + i}/clip-${i}.mp4`,
        kind: 'video' as const,
        source: 'dom-attribute' as const,
      })),
    ];
    const report = received(0, { pageUrl: `${PAGE}?list=popular&page=2`, claims });
    const { context } = applyReport(EMPTY_CONTEXT, 0, report);

    expect(context.pageCandidates).toHaveLength(200);
    expect(jsonBytes(context)).toBeLessThan(MAX_TAB_CONTEXT_BYTES);
  });

  it('W8: a hostile page with many frames at the report caps stays within the budget', async () => {
    const api = createFakeBrowserApi();
    __setBrowserApi(api);
    const store = new TabStore(api.storage.session);

    // The top frame: the page and its real player.
    const player = 'https://cdn.site.example/v/1/master.m3u8';
    await store.applyReport(
      1,
      0,
      received(0, {
        pageUrl: PAGE,
        poster: 'https://img.site.example/v/1/poster.jpg',
        claims: [
          { url: player, kind: 'video', source: 'dom-element', title: 'The real video' },
          { url: player.replace('master', '720p'), kind: 'video', source: 'page-hook' },
        ],
      }),
    );

    // Forty sub-frames, each at the per-report caps: a page URL of the longest
    // accepted length (copied into every candidate), and 200 claims.
    const longPageUrl = `https://ads.example/frame?${'x'.repeat(MAX_URL_LENGTH - 40)}`;
    for (let frame = 1; frame <= 40; frame += 1) {
      const claims = Array.from({ length: 200 }, (_unused, i) => ({
        url: `https://ads.example/f${frame}/v${i}/${'p'.repeat(1_000)}.mp4`,
        kind: 'video' as const,
        source: 'dom-element' as const,
      }));
      await store.applyReport(
        1,
        frame,
        received(frame, {
          pageUrl: longPageUrl,
          claims,
          // One iframe has a DRM player; folding frames must not lose that.
          signals: signals({ hasMediaKeys: frame === 7, mediaElements: 1 }),
        }),
      );
    }

    const context = await store.context(1);
    expect(jsonBytes(context)).toBeLessThanOrEqual(MAX_TAB_CONTEXT_BYTES);
    // The page's identity and its real player survive the flood.
    expect(context.pageUrl).toBe(PAGE);
    expect(context.pageTitle).toBe('Frame 0');
    expect(context.routeStartedAt).toBe(LOADED_AT);
    expect(context.pagePoster).toBe('https://img.site.example/v/1/poster.jpg');
    const top = context.pageCandidates.filter((c) => c.frameId === 0);
    expect(top.map((c) => c.source).sort()).toEqual(['dom-element', 'page-hook']);
    // And the tab still says one of its frames uses DRM.
    expect(tabSignals(context).hasMediaKeys).toBe(true);
  });
});

describe('W8: what goes first when a context is over its budget', () => {
  /** A context with the given candidates, in the order the fold stored them. */
  function contextOf(candidates: MediaCandidate[], frames: number[]): TabContext {
    return {
      pageUrl: PAGE,
      pageTitle: 'Watch one',
      routeStartedAt: LOADED_AT,
      signalsByFrame: Object.fromEntries(frames.map((frame) => [frame, signals()])),
      pageCandidates: candidates,
    };
  }

  /** The budget that fits exactly `expected`, so the test pins the byte count too. */
  function budgetFor(expected: TabContext): number {
    return jsonBytes(expected);
  }

  it('W8: sub-frames lose links, then fetched URLs, then elements; the oldest report first', () => {
    // Frame 3 reported before frame 5; each report lists elements, fetched, links.
    const older = [
      candidate('https://a.example/3/element.mp4', 'dom-element', 3),
      candidate('https://a.example/3/fetched.m3u8', 'page-hook', 3),
      candidate('https://a.example/3/link.mp4', 'dom-attribute', 3),
    ];
    const newer = [
      candidate('https://a.example/5/element.mp4', 'dom-element', 5),
      candidate('https://a.example/5/fetched.m3u8', 'page-hook', 5),
      candidate('https://a.example/5/link.mp4', 'dom-attribute', 5),
    ];
    const top = [candidate('https://site.example/top/link.mp4', 'dom-attribute', 0)];
    const all = [...top, ...older, ...newer];
    const frames = [0, 3, 5];

    // Three must go: both frames' links, then the older frame's fetched URL.
    // The top frame's link outlives every sub-frame's element.
    const expected = contextOf([top[0], older[0], newer[0], newer[1]] as MediaCandidate[], frames);
    expect(fitContext(contextOf(all, frames), budgetFor(expected))).toEqual(expected);
  });

  it('W8: within one report, the claims at its end go first', () => {
    const claims = [
      candidate('https://a.example/4/first.mp4', 'dom-attribute', 4),
      candidate('https://a.example/4/second.mp4', 'dom-attribute', 4),
      candidate('https://a.example/4/third.mp4', 'dom-attribute', 4),
    ];
    const expected = contextOf(claims.slice(0, 1), [0, 4]);
    expect(fitContext(contextOf(claims, [0, 4]), budgetFor(expected))).toEqual(expected);
  });

  it("W8: sub-frames' signals are folded before the top frame loses anything, totals intact", () => {
    const frames = Array.from({ length: 3_000 }, (_unused, i) => i);
    const context: TabContext = {
      ...contextOf([candidate(`${PAGE}/player.mp4`, 'dom-element', 0)], []),
      signalsByFrame: Object.fromEntries(
        frames.map((frame) => [
          frame,
          signals({ mediaElements: 1, hasMediaSource: frame === 2_999, playerFrames: frame % 2 }),
        ]),
      ),
    };
    expect(jsonBytes(context)).toBeGreaterThan(MAX_TAB_CONTEXT_BYTES);

    const fitted = fitContext(context);
    expect(jsonBytes(fitted)).toBeLessThanOrEqual(MAX_TAB_CONTEXT_BYTES);
    expect(Object.keys(fitted.signalsByFrame).sort()).toEqual(['0', FOLDED_FRAMES]);
    expect(tabSignals(fitted)).toEqual(tabSignals(context));
    expect(fitted.pageCandidates).toEqual(context.pageCandidates);
  });

  it('W8: a top frame alone over the budget keeps its identity and its most valuable claims', () => {
    const long = (i: number) => `https://site.example/${i}/${'q'.repeat(2_000)}.mp4`;
    const claims = [
      candidate(long(0), 'dom-element', 0),
      candidate(long(1), 'page-hook', 0),
      ...Array.from({ length: 150 }, (_unused, i) => candidate(long(i + 2), 'dom-attribute', 0)),
    ];
    const context = { ...contextOf(claims, [0]), pagePoster: 'https://img.site.example/p.jpg' };
    expect(jsonBytes(context)).toBeGreaterThan(MAX_TAB_CONTEXT_BYTES);

    const fitted = fitContext(context);
    expect(jsonBytes(fitted)).toBeLessThanOrEqual(MAX_TAB_CONTEXT_BYTES);
    expect(fitted).toMatchObject({
      pageUrl: PAGE,
      pageTitle: 'Watch one',
      routeStartedAt: LOADED_AT,
      pagePoster: 'https://img.site.example/p.jpg',
    });
    expect(fitted.pageCandidates.slice(0, 2)).toEqual(claims.slice(0, 2));
  });

  it('W8: identity alone is kept even when every candidate has to go', () => {
    const context = contextOf([candidate(`${PAGE}/a.mp4`, 'dom-element', 0)], [0]);
    const fitted = fitContext(context, 1);
    expect(fitted.pageCandidates).toEqual([]);
    expect(fitted.pageUrl).toBe(PAGE);
  });
});

describe('W8: the stored scan has a budget too', () => {
  function scan(candidates: MediaCandidate[], rejected: ScanResult['rejected']): ScanResult {
    return {
      tabId: 1,
      pageUrl: PAGE,
      pageTitle: 'Watch one',
      scannedAt: 1,
      candidates,
      rejected,
      stats: {
        networkRequestsObserved: 0,
        mediaElements: 0,
        candidatesRaw: 0,
        candidatesAfterDedupe: 0,
        manifestsParsed: 0,
        byProtocol: { progressive: 0, hls: 0, dash: 0, blob: 0, data: 0, unknown: 0 },
        parseErrors: 0,
      },
    };
  }

  it('W8: drops the debug-only rejected list first, then the lowest-ranked candidates', () => {
    const ranked = [0, 1, 2].map((i) => candidate(`${PAGE}/${i}.mp4`, 'network', 0));
    const rejected = [0, 1].map((i) => ({ url: `${PAGE}/r${i}.mp4`, reason: 'below threshold' }));

    const onlyRejectedGone = scan(ranked, []);
    expect(fitScan(scan(ranked, rejected), jsonBytes(onlyRejectedGone))).toEqual(onlyRejectedGone);

    const bestTwo = scan(ranked.slice(0, 2), []);
    expect(fitScan(scan(ranked, rejected), jsonBytes(bestTwo))).toEqual(bestTwo);
  });

  it('W8: saveScan stores and returns the fitted scan, so the popup shows what can start', async () => {
    const api = createFakeBrowserApi();
    __setBrowserApi(api);
    const store = new TabStore(api.storage.session);
    const huge = Array.from({ length: 300 }, (_unused, i) =>
      candidate(`https://cdn.example/${i}/${'z'.repeat(2_000)}.mp4`, 'network', 0),
    );

    const stored = await store.saveScan(1, scan(huge, []));
    expect(jsonBytes(stored)).toBeLessThanOrEqual(MAX_TAB_SCAN_BYTES);
    expect(stored.candidates.length).toBeGreaterThan(0);
    expect(await store.lastScan(1)).toEqual(stored);
  });
});

describe('W8: bytes are counted as UTF-8', () => {
  it('W8: counts two, three and four bytes where UTF-8 does', () => {
    expect(jsonBytes('a')).toBe(3); // with its quotes
    expect(jsonBytes('é')).toBe(4);
    expect(jsonBytes('中')).toBe(5);
    expect(jsonBytes('🎬')).toBe(6);
    expect(jsonBytes({ title: '中文 🎬' })).toBe(
      new TextEncoder().encode('{"title":"中文 🎬"}').length,
    );
  });
});
