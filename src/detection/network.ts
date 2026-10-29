/**
 * Network observation (PRD s5).
 *
 * The DOM only tells you what the page admits to. Most modern players fetch a
 * manifest and never put its URL in the document, so the response observer is
 * where HLS and DASH are actually found.
 *
 * Observe-only: we register `onResponseStarted`, which cannot block, redirect or
 * modify anything. We read the status line and the response headers, never a
 * body and never a request header (SECURITY.md "What the network observer sees").
 *
 * What it cannot see: a webRequest listener only fires for hosts the user has
 * granted, and a site grant is one host. Media served from a separate CDN host
 * is found from inside the page instead - the page hook and Resource Timing in
 * the content script (content/index.ts).
 *
 * Memory: a service worker is killed and restarted constantly, and a video page
 * can emit thousands of segment requests. Segments never become candidates;
 * state is per-tab, capped, and dropped when the tab navigates or closes.
 */

import type { WebRequestDetails } from '../browser/api.ts';
import { browserApi } from '../browser/index.ts';
import { MAX_NETWORK_CANDIDATES_PER_TAB } from '../core/limits.ts';
import { createLogger } from '../core/log.ts';
import type { MediaCandidate } from '../core/types.ts';
import { withoutFragment } from '../media/fingerprint.ts';
import { classifyMediaUrl, normalizeMime } from '../media/format.ts';
import { makeCandidate } from './candidate.ts';

const log = createLogger('network');

/**
 * How far before a route's start a request may be and still count as that
 * route's. The page's clock and the worker's are the same wall clock, but a
 * report is built a moment after the route change it describes.
 */
const ROUTE_CLOCK_SLACK_MS = 1_000;
/** Prerendered pages kept per tab; a page rarely speculates on more than a couple of links. */
const MAX_PRERENDERS_PER_TAB = 3;

/**
 * Content types the browser shows as a page. A top-level response of any
 * other type (a .zip, an installer, `application/octet-stream`) is a download
 * and leaves the current page where it is.
 */
const SHOWN_AS_A_PAGE =
  /^(text\/|image\/|video\/|audio\/|application\/(xhtml\+xml|xml|pdf|json|javascript)$|[^/]+\/[^/]+\+(xml|json)$)/i;

/** Request types worth looking at. `xmlhttprequest`/`fetch` carry manifests. */
const INTERESTING_TYPES = new Set([
  'media',
  'xmlhttprequest',
  'object',
  'other',
  'main_frame',
  'sub_frame',
]);

export interface TabNetworkState {
  candidates: Map<string, MediaCandidate>;
  requestsObserved: number;
  pageUrl: string;
  pageTitle: string;
}

/** What the top frame's report says about the page, as far as this observer cares. */
export interface TopFrameReport {
  pageUrl: string;
  pageTitle: string;
  /** The tab store saw a navigation (tab-store.ts `applyReport`). */
  navigated: boolean;
  /** PageReport.routeStartedAt: when the page now on screen began. */
  routeStartedAt: number;
}

export type NetworkListener = (tabId: number, candidate: MediaCandidate) => void;

export class NetworkObserver {
  private readonly tabs = new Map<number, TabNetworkState>();
  /**
   * Traffic of pages prerendered in a tab (Speculation Rules), keyed by the
   * prerendered frame's id. Their players may fetch a manifest before the user
   * has gone there: that belongs to the page they are going to, not to the one
   * on screen. Adopted if the user navigates to that URL, dropped otherwise.
   */
  private readonly prerenders = new Map<number, Map<number, TabNetworkState>>();
  private readonly listeners = new Set<NetworkListener>();
  private unsubscribe: (() => void) | null = null;

  /**
   * Register for the origins the user has granted, and only those.
   *
   * A `webRequest` listener does nothing without a matching host permission -
   * Chrome says exactly that at install time ("You need to request host
   * permissions in the manifest file in order to be notified about requests
   * from the webRequest API"), and it is right: with no grant the listener
   * never fires. So this is a no-op until a grant arrives, and it is called
   * again when one does. Safe to call repeatedly; it replaces rather than
   * stacks.
   */
  start(urlPatterns: string[]): void {
    this.stop();
    if (urlPatterns.length === 0) {
      log.info('no granted origins; network observer not registered');
      return;
    }
    const { webRequest } = browserApi();
    if (!webRequest.isAvailable()) {
      log.info('webRequest not granted; network observer not registered');
      return;
    }

    try {
      this.unsubscribe = webRequest.onResponseStarted({ urls: urlPatterns }, (details) =>
        this.handle(details),
      );
      log.info(`network observer watching ${urlPatterns.length} origin pattern(s)`);
    } catch (err) {
      // Never let this take the worker down; the popup must still get answers.
      this.unsubscribe = null;
      log.warn(
        'could not register the network observer',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  onCandidate(listener: NetworkListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The tab's top frame reported which page it is on.
   *
   * On a navigation, what was seen before the new page began belongs to the
   * old one, and what was seen since belongs to the new one - even when the
   * report arrives after the new page has already fetched its manifest (it
   * usually does). The report says when the page began, so the cut is made
   * there rather than at the moment the report happens to arrive. A new
   * document was already cut at its own request (`visibleStateFor`); this
   * covers what no request marks: a pushState route change and a
   * back-forward-cache restore. A prerendered page that has just been shown
   * brings what it fetched while it was hidden.
   */
  topFrameReported(tabId: number, report: TopFrameReport): void {
    let state = this.tabs.get(tabId) ?? this.createState();
    if (report.navigated) {
      state = this.takePrerender(tabId, report.pageUrl) ?? seenSince(state, report.routeStartedAt);
      this.prerenders.delete(tabId); // speculations belonged to the old page
    }
    state.pageUrl = report.pageUrl;
    state.pageTitle = report.pageTitle;
    this.tabs.set(tabId, state);
  }

  forgetTab(tabId: number): void {
    this.tabs.delete(tabId);
    this.prerenders.delete(tabId);
  }

  candidatesFor(tabId: number): MediaCandidate[] {
    return [...(this.tabs.get(tabId)?.candidates.values() ?? [])];
  }

  /** Requests seen for the tab's current page, segments included. */
  requestsObserved(tabId: number): number {
    return this.tabs.get(tabId)?.requestsObserved ?? 0;
  }

  private createState(): TabNetworkState {
    return {
      candidates: new Map(),
      requestsObserved: 0,
      pageUrl: '',
      pageTitle: '',
    };
  }

  private handle(details: WebRequestDetails): void {
    if (details.tabId < 0) return; // background request, not attributable to a tab
    if (!INTERESTING_TYPES.has(details.type)) return;

    const headers = headerMap(details.responseHeaders);
    const prerendering = details.documentLifecycle === 'prerender';
    const state = prerendering
      ? this.prerenderStateFor(details)
      : this.visibleStateFor(details, headers);
    if (!state) return;
    state.requestsObserved += 1;

    if (details.statusCode >= 400) return;
    if (details.method !== 'GET') return;

    const contentType = normalizeMime(headers.get('content-type'));
    const media = classifyMediaUrl(details.url, contentType);
    // Segments still counted as observed requests above, which diagnosis reads.
    if (!media || media.isSegment) return;

    // A manifest's Content-Length is the size of a text file, not of the video.
    const isManifest = media.protocol === 'hls' || media.protocol === 'dash';
    const sizeBytes = isManifest ? undefined : resourceSize(details.statusCode, headers);
    const candidate = makeCandidate({
      url: details.url,
      pageUrl: state.pageUrl,
      pageTitle: state.pageTitle,
      kind: media.kind,
      source: 'network',
      frameId: details.frameId,
      ...(contentType ? { mimeType: contentType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes, sizeEstimated: false } : {}),
    });

    const known = state.candidates.get(candidate.id);
    if (known) {
      // Seen again: it belongs to the route that fetched it now, too (a player
      // that survives a pushState re-fetches its manifest on the new route).
      state.candidates.set(candidate.id, { ...known, seenAt: candidate.seenAt });
      return;
    }

    if (state.candidates.size >= MAX_NETWORK_CANDIDATES_PER_TAB) {
      const oldest = state.candidates.keys().next();
      if (!oldest.done) state.candidates.delete(oldest.value);
    }
    state.candidates.set(candidate.id, candidate);

    log.debug('candidate from network', { url: candidate.url, kind: candidate.kind });
    // A prerendered page is not on screen; nothing to rescan until it is.
    if (prerendering) return;
    for (const listener of this.listeners) listener(details.tabId, candidate);
  }

  /** The state of the page on screen, starting a new one at a navigation. */
  private visibleStateFor(
    details: WebRequestDetails,
    headers: Map<string, string>,
  ): TabNetworkState {
    if (replacesVisiblePage(details, headers)) {
      // A new top-level document: this is the navigation boundary.
      this.tabs.set(details.tabId, { ...this.createState(), pageUrl: details.url });
    }
    const state = this.tabs.get(details.tabId) ?? this.createState();
    this.tabs.set(details.tabId, state);
    return state;
  }

  /** The state of one prerendered page, or undefined for a frame we cannot place. */
  private prerenderStateFor(details: WebRequestDetails): TabNetworkState | undefined {
    const byFrame = this.prerenders.get(details.tabId) ?? new Map<number, TabNetworkState>();
    this.prerenders.set(details.tabId, byFrame);
    if (details.type === 'main_frame') {
      if (byFrame.size >= MAX_PRERENDERS_PER_TAB) {
        const oldest = byFrame.keys().next();
        if (!oldest.done) byFrame.delete(oldest.value);
      }
      byFrame.set(details.frameId, { ...this.createState(), pageUrl: details.url });
    }
    // Requests from the prerendered page's own frame; its iframes are dropped.
    return byFrame.get(details.frameId);
  }

  private takePrerender(tabId: number, pageUrl: string): TabNetworkState | undefined {
    const target = withoutFragment(pageUrl);
    for (const state of this.prerenders.get(tabId)?.values() ?? []) {
      if (withoutFragment(state.pageUrl) === target) return state;
    }
    return undefined;
  }
}

/**
 * The part of a tab's state that belongs to a page that began at `startedAt`.
 * The request count is kept whole: it only feeds diagnosis's "has playback
 * started" guess, which an over-count on a route change does not mislead.
 */
function seenSince(state: TabNetworkState, startedAt: number): TabNetworkState {
  const cutoff = startedAt - ROUTE_CLOCK_SLACK_MS;
  return {
    ...state,
    candidates: new Map(
      [...state.candidates].filter(([, candidate]) => candidate.seenAt >= cutoff),
    ),
  };
}

/**
 * The size of the whole resource. A 206 answers one range of it, so its
 * Content-Length is that range; the total is after the slash in Content-Range
 * (`bytes 0-1023/146515`), or unknown (`/*`).
 */
function resourceSize(status: number, headers: Map<string, string>): number | undefined {
  const raw =
    status === 206
      ? /\/(\d+)\s*$/.exec(headers.get('content-range') ?? '')?.[1]
      : headers.get('content-length');
  const bytes = Number(raw);
  return raw !== undefined && Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
}

/**
 * Whether a response is about to become the page the user is looking at.
 * Not every top-level response does: a link that downloads a file (by
 * `Content-Disposition: attachment`, or because the browser cannot show its
 * type) or answers 204/205 leaves the current page in place. Resetting on
 * those would silently drop the media of the page that is still showing.
 * Prerendered pages never get here (`prerenderStateFor`).
 */
function replacesVisiblePage(details: WebRequestDetails, headers: Map<string, string>): boolean {
  if (details.type !== 'main_frame' || details.frameId !== 0) return false;
  if (details.statusCode === 204 || details.statusCode === 205) return false;
  if (/^\s*attachment/i.test(headers.get('content-disposition') ?? '')) return false;
  const type = normalizeMime(headers.get('content-type'));
  return type === undefined || SHOWN_AS_A_PAGE.test(type);
}

function headerMap(
  headers: Array<{ name: string; value?: string }> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of headers ?? []) {
    if (header.value !== undefined) map.set(header.name.toLowerCase(), header.value);
  }
  return map;
}
