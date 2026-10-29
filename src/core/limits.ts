/**
 * The caps on what a web page can make MediaGrab hold or do: every limit on
 * page input, in one place. (Limits on downloads live with the code they
 * bound: the manifest size cap in core/fetch.ts, the segment cap in
 * manifests/segment-plan.ts. The one exception is the assembly ceiling at the
 * end of this file, which the scan reads as well as the download.)
 *
 * A page is untrusted input (SECURITY.md): it can put ten thousand <video>
 * tags in its DOM, fetch a new URL every millisecond, or report forever. Each
 * number below bounds one of those, and says why it is the size it is, so a
 * change to one is a decision about that trade-off rather than a guess.
 */

/** Longest URL accepted from a page. Real media URLs, signed ones included, stay far below. */
export const MAX_URL_LENGTH = 8_192;

/** Longest title or label kept from a page: enough for any real title, not a novel. */
export const MAX_TITLE_LENGTH = 300;

/**
 * Candidates one frame remembers (content script) and reports at once.
 * A frame with more than this is a gallery or a spam page; the newest win.
 */
export const MAX_CANDIDATES_PER_FRAME = 200;

/**
 * Candidates the worker keeps for one tab across all its frames. Several
 * frames at the per-frame cap still fit; a page that nests dozens of media
 * frames loses its oldest entries rather than the worker's memory.
 */
export const MAX_CANDIDATES_PER_TAB = 1_000;

/**
 * Media responses the network observer keeps per tab. Segments never count
 * (they are dropped first), so this is manifests and files - generous.
 */
export const MAX_NETWORK_CANDIDATES_PER_TAB = 300;

/**
 * Characters of candidate claims one report may carry (about 256 KB). Session
 * storage is 10 MB shared by every tab, so one hostile frame must not be able
 * to fill it: 200 claims with 8 KB URLs and 50 subtitle tracks each could.
 * A real page's report is a few KB.
 */
export const MAX_REPORT_CLAIM_CHARS = 256_000;

/** Longest MIME type accepted from a page; real ones, parameters included, are under 100. */
export const MAX_MIME_LENGTH = 200;

/** Text tracks on one claim: more than any real player offers. */
export const MAX_SUBTITLES_PER_CLAIM = 50;

/** Distinct URLs the page hook remembers having posted, per page, so players re-polling a manifest do not flood. */
export const MAX_HOOK_URLS = 500;

/** Links and data-attribute elements read per DOM scan. A page with more is not a video page. */
export const MAX_DOM_LINKS = 2_000;
export const MAX_DOM_DATA_ELEMENTS = 500;

/** A count a page reports (media elements, player frames) is advisory; above this it is noise. */
export const MAX_REPORTED_COUNT = 1_000;

/** Widest or tallest frame accepted from a page: 16K, the largest video anyone ships. */
export const MAX_FRAME_DIMENSION = 16_384;

/** JSON-LD nesting followed; real VideoObject metadata is two or three levels deep. */
export const MAX_JSON_LD_DEPTH = 6;

/** Largest JSON-LD block parsed. Real VideoObject metadata is a few KB. */
export const MAX_JSON_LD_CHARS = 200_000;

/**
 * Manifests fetched per scan. Each is a network round trip made from the
 * worker; a page listing fifty playlists gets its eight best-ranked expanded.
 */
export const MAX_MANIFEST_EXPANSIONS = 8;

/**
 * `storage.session` quota, shared by every tab and by the download queue:
 * 10,485,760 bytes (`chrome.storage.session.QUOTA_BYTES` in Chrome's storage
 * reference; MDN documents the same 10 MB for Firefox). A write that would pass
 * it is refused outright, so whichever tab writes next - any tab - loses its
 * detection state. Chrome counts "estimated dynamically allocated memory" of
 * keys and values, which runs above the JSON length the budgets below measure.
 */
const SESSION_STORAGE_QUOTA_BYTES = 10_485_760;

/** Tabs that may each hold a page at its full budget at the same time. */
const TABS_AT_FULL_BUDGET = 16;

/**
 * What one tab's detection state (`ctx:` + `scan:` in background/tab-store.ts)
 * may occupy in session storage, as UTF-8 JSON: 320 KiB.
 *
 * Derived, not picked: half the quota is shared among 16 tabs at their full
 * budget; the other half is headroom for the download queue and for the gap
 * between JSON bytes and Chrome's memory estimate. A real page's state is a few
 * KB and never comes near this; a page of 200 video links stays under it. A
 * hostile page is another matter: without a total, 200 claims per frame, each
 * carrying an 8 KB page URL that MAX_REPORT_CLAIM_CHARS does not count, is
 * ~2 MB per frame, and five frames fill the quota. Over the budget, the tab
 * store drops its least valuable data first and keeps the page's identity
 * (see `fitContext` / `fitScan`).
 */
export const MAX_TAB_SESSION_BYTES = Math.floor(
  SESSION_STORAGE_QUOTA_BYTES / 2 / TABS_AT_FULL_BUDGET,
);

/** The page context's half of the tab's budget (what frames reported). */
export const MAX_TAB_CONTEXT_BYTES = Math.floor(MAX_TAB_SESSION_BYTES / 2);

/** The last scan's half of the tab's budget (what the popup shows). */
export const MAX_TAB_SCAN_BYTES = MAX_TAB_SESSION_BYTES - MAX_TAB_CONTEXT_BYTES;

/**
 * Largest file assembled from segments: 1.5 GB. Assembly happens in memory -
 * one copy of the file, in the browser's blob storage (see the header of
 * downloads/segment-fetcher.ts) - so there is a ceiling, and above it the
 * download is refused with a clear error rather than crashing the page that
 * assembles it. Streaming to disk instead needs a native host (README "Known
 * limitations").
 *
 * It lives here rather than beside the fetcher that enforces it because the
 * scan reads it too (detection/saveability.ts marks a rendition over it
 * "too large" before the click), and detection must not import the download
 * code to learn a number. One constant, two readers, no copy to drift.
 */
export const MAX_ASSEMBLY_BYTES = 1_500_000_000;
