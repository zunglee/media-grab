# Changelog

All notable changes to MediaGrab are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.6] — 2026-09-25

The runway from `CONTEXT-RUNWAY.md`: the six open product decisions (P0-1…P0-5 and P1-6) made under
owner delegation (ARCHITECTURE.md D16–D21) and executed, then independently re-audited, fixed, verified,
and run in a real Chromium. Full report:
`reports/2026-09-25-runway-0.1.6.md`.

### Decided

- **D16 Durability.** A worker restart loses no task (a segmented download caught mid-fetch is marked
  interrupted, with Retry). After an extension update or a browser restart,
  downloads the browser still holds are followed again by their id; the rest stay listed as
  interrupted, without Retry, until removed — no address is kept on disk.
- **D17 Target pages.** Single-page-app players first: History API, hash routes, the Navigation API.
- **D18 Network identity.** Cookies never; the page as Referer, only to hosts the user has allowed.
- **D19 Browsers.** Chromium is the target and the release gate; Firefox is experimental.
- **D20 Best.** Sound first, then resolution, then bitrate; a stream that only exists as separate video
  and audio gets both files.
- **D21 Saveability.** Every row says whether it can be saved, and why not, before the click.

### Added

- **The download queue survives the worker.** Saved in session storage on every change that matters
  (`background/queue-store.ts`), with a URL-free trace in local storage for updates and restarts;
  a new worker takes charge of it at start-up. A file the browser finished while no worker ran is now
  written to history.
- **Referer on MediaGrab's own requests** through session `declarativeNetRequest` rules
  (`downloads/referer-rules.ts`, permission `declarativeNetRequestWithHostAccess` — no install
  warning). Hot-link-protected CDNs you have allowed now download.
- **"Allow ‹host› and retry"** on a download refused (403) by a host MediaGrab has no access to: the
  row says the host refused, the button asks for that host from the click, then retries.
- **Saveability** decided during the scan, including one cached probe of the best HLS rendition's
  media playlist: encrypted, live, multi-Period, too large, MediaSource-only and "nothing to fetch"
  rows are shown disabled with the reason; "Best download" skips them.
- **Hash-routed apps and the Navigation API** are followed as route changes (`inject/routes.ts`); a
  plain `#anchor` is not a route change.
- **Automated release gates** for worker death and updates (`tests/extension/durability.spec.ts`,
  stopping the worker through the DevTools protocol), and a written checklist for what automation
  cannot reach (TESTING.md § 5).

### Changed

- **"Best download"** (popup, shortcut, context menu) follows D20; for a split stream it queues the
  best video and its paired audio.
- A separate audio track is saved as an audio file (`.m4a` / its real container, kind "audio").
- The manager refuses a rendition the scan marked unsaveable, even if a stale popup asks for it.
- The offscreen document is closed whenever no segmented download needs it, which also frees what a
  killed worker left in it.
- Segmented downloads keep each segment in the browser's blob store and build the file by reference:
  one copy of the file in memory at the peak instead of two.
- Each tab's detection state is held to a byte budget (`core/limits.ts`); a hostile page with many
  frames loses its sub-frames' claims first, never the page's identity.
- Requests to the offscreen document report the browser's reason when they cannot be delivered.

### Fixed

- **Two segmented downloads starting together could fail with "The offscreen document did not
  respond".** Chrome lists a document as soon as its creation starts, before its script listens; a
  second download saw it and sent work too early. Found during integration by the split-stream test;
  latent since the offscreen document was introduced, for the first two concurrent downloads of a session.
- A played `<video>` and the request it made, claimed in one report, lost the element's title and
  poster to the bare request.
- A late-injected content script (right after a grant) could list an earlier route's media as the
  current page's.

### Fixed — found by the independent re-audit of 0.1.6

- **A download recovered after an update vanished at the next worker restart.** Tasks recovered without
  their address were left out of the saved queue; they are saved now, and the trace fills any gap.
- **A Referer rule could outlive its task** when the task was cancelled while the rule was being set.
- **A stop while the Referer rule or the offscreen document was being set up did not stop the work**:
  a Save dialog could open for a cancelled file, or the whole stream be fetched for nothing.
- **"Allow ‹host› and retry" disappeared after a worker restart**, and did not help when the refusing
  host was a redirect target; both kept now.
- **Bringing the queue back could run more downloads than the settings allow.**
- **A killed worker's offscreen document** kept fetching; it is closed before the queue is restored, and
  a retried task can no longer lose its cancel to the old attempt.
- **Old Referer rules** are cleared when a worker starts, not at the first new download.
- **Saving the queue** no longer skips changes made during the restore or just as a save finishes,
  and retries a failed write after a pause rather than on every progress tick.
- **A row could look saveable and fail on click** when only its audio fitted; its status now comes from
  the renditions "Best" can take, and its button says why when there are none.
- **"Best" could pair an audio description, commentary or a louder dub** with the video; it pairs the
  programme's sound (DASH Role and DVB Accessibility, HLS `describes-video`, then the first language).
- **A placeholder link (`#`, `#!`, `#/`) wiped the page's media** as if it were a route change.
- **A live HLS or DASH stream the scan could not decide** downloaded whatever window it listed; the
  download now refuses it too.
- "Allow ‹host›" was offered only for exact hostnames without `_`, and not when only the other scheme
  was granted; manifest refusals name the host that answered after a redirect.

### Removed

- `background/paused-downloads.ts` and its test: the saved queue (`background/queue-store.ts`)
  replaces it; the 0.1.5 key is read once and dropped.

### Security

- The page is named as Referer only to hosts the user has granted, only on requests not tied to a
  tab, only while a download uses the host (D18); cookies are never added. New permission
  `declarativeNetRequestWithHostAccess` (no install warning).
- What survives an update or restart (`downloads:trace`) holds no URL; the queue with its URLs lives
  in session storage only.

### Tests

- 560 unit tests (was 380): durability, Referer rules, caps and assembly, navigation, best and
  saveability, integration, and a regression test for each re-audit finding.
- 72 Playwright tests (was 52): 27 UI, 45 real-extension. Of the 15 new real-browser tests, 12
  fail against 0.1.5 for the bug they target; the other 3 guard behaviour 0.1.5 already had.

## [0.1.5] — 2026-09-25

A second code-and-flow audit, this time of every layer (the first pass read the parsers and the UI for
contracts only), a SOLID simplification of what it found, and an independent re-audit with a
verification round. Full report: `reports/2026-09-25-solid-audit-2.md`.

### Fixed — detection

- **Manifests on a CDN host were missed.** A site grant is one host, and the network observer cannot
  see another. The page hook now runs as a MAIN-world content script registered at `document_start`
  (it was injected by `<script>` tag after `DOMContentLoaded`, after most players had already fetched
  their manifest), its XHR check actually runs (a `{ once: true }` listener was spent by `open()`
  itself), and the content script reads Resource Timing, which lists every URL the page fetched.
- **Every HLS segment became a row** when the page hook saw it; "Best download" could save one 6-second
  segment. Every observer now drops segments through one rule, `classifyMediaUrl`.
- **`blob:` URLs were offered as downloads** on every MediaSource player, hiding the explanation.
- **A single-page app kept the old route's media**, and a `replaceState` that only tidied tracking
  parameters threw away the manifest the page had just fetched. A navigation is now the top frame's
  `routeStartedAt` changing (pushState, back/forward, back-forward-cache restore), not a URL compare;
  the network observer keeps what the new route fetched before its report.
- **`<base href>` pages** (every Angular app) resolved media URLs to 404s; **one `<video>` with a WebM
  and an MP4 source** saved the MP4 as `.webm`; **a DRM capability probe** marked clear pages
  "protected"; **ad iframes** produced "the media lives in an embedded frame".
- **A master's rendition and subtitle playlists were extra rows** (a subtitle playlist was offered as a
  70-second video); they now fold into the master. Its audio playlists stay, as audio rows.
- **LL-HLS playlist reloads** (`_HLS_msn=`) each became a new candidate and a new scan.
- **Pages could hand the worker finished candidates** with their own variants, score or DRM verdict, and
  `javascript:` URLs. Reports now carry allow-listed claims, which the worker rebuilds.

### Fixed — downloads and parsers

- **A different video was refused as a duplicate** when it shared a file name, and every DASH rendition
  of a manifest was a "duplicate" of the one running. Duplicates are now the same rendition.
- **HLS fMP4/CMAF renditions were saved as `.ts`.** The playlist now settles the container, and the
  name is rebuilt from the naming template with the real extension.
- **Long titles lost the file extension** (`…[1080p].mp`) and could split an emoji.
- **DASH on-demand representations** wrote the init segment twice and downloaded a whole file as one
  segment with a 60-second timeout; they are now plain browser downloads. SegmentList ranges without
  `@media`, `P0Y0M0D…` durations, `r="-1"` with a presentation time offset, inheritance from Period
  and AdaptationSet templates, and `$Time$` above 2^53 are all handled.
- **Streams too long to assemble were silently cut** at 20,000 segments; they are now refused. So are
  multi-Period DASH streams (usually adverts) and HLS streams whose init changes part-way, rather than
  saved as files that stop or break.
- **Cancelling in the browser's own download list** showed "network failed" with a Retry button; a full
  disk did too. **Firefox's Pause** (which the browser reports as an interrupted, `USER_CANCELED`
  download with `paused: true`) is recognised as a pause; pausing or resuming from the browser's list
  is followed; closing Firefox's Save As dialog is a cancel, not an error.
- **The "parallel segments" setting grew to 8 on its own**; 404/403 were retried; a server ignoring a
  byte range produced a silently corrupt file; a transient playlist failure failed the download.
- **Progress for segmented downloads** used the manifest's peak-bandwidth guess as if exact; it now
  follows the segment count and marks estimates "~".
- **Specific error messages never reached the user**; a failed row now shows the plain headline and
  what exactly happened (with any segment URL redacted).
- **Separate audio could not be downloaded at all**: a stream's audio tracks are now offered in the
  row's list of qualities, and an audio playlist the page fetched is an audio row.
- **A manifest's own size** ("3 KB") was shown as the video's size and used as the progress total.
- **A quality chosen in the popup that a rescan no longer lists** was silently swapped for "best";
  it is now refused with an explanation. Quality ids no longer change when a URL is re-signed.

### Fixed — UI and storage

- **Firefox: "Enable on this site" did nothing** (the request included a permission Firefox declares
  as required, so the whole request was rejected).
- The reload notice after a grant was cleared before it showed; broadcasts sent while the popup opened
  were lost; "Best download" stayed enabled when nothing could be downloaded; a video-only rendition
  did not say "no sound"; Pause was offered where it throws the download away; accessibility names for
  progress bars and row buttons; the options page's all-sites checkbox and clamped values.
- History stores no URLs, serialises writes and labels days by local date.

### Changed

- The badge shows the detection count only; the download percentage never showed on the tabs where
  downloads start (a per-tab badge overrides the global one).
- No `web_accessible_resources`: a site can no longer probe for MediaGrab.
- Context menus are created on install, not on every worker wake; a right-click on a particular video
  downloads that video.
- Structure: `core/limits.ts` (every cap on page input, with its reason), `core/hook-protocol.ts`,
  `detection/candidate.ts`, `detection/manifest-cache.ts`, `downloads/interrupt-reasons.ts`,
  `downloads/retry.ts`, `manifests/{url,drm-systems}.ts`, `manifests/dash/{model,segment-info}.ts`,
  `ui/lib/popup-controller.ts`. See ARCHITECTURE.md D13–D15.

## [0.1.4] — 2026-09-25

A code-and-flow audit, a SOLID restructuring of the two largest modules, and a re-audit.
Full report: `reports/2026-09-25-solid-audit.md`.

### Fixed

- **"Best download" could save the lowest quality.** The popup button, the `download-best` shortcut
  and the context menu took the first rendition in manifest order; many HLS masters list the lowest
  rung first. All three now use `pickBestDownload`, the same rule as the row's own "Best" button.
- **Media found only in the DOM could vanish.** One DOM pass sent two messages that the worker
  handled concurrently with read-modify-write on session storage, so the page-context write could
  erase the candidates. On a page whose only media is a `<video>` the network never fetched, nothing
  was ever shown. Reproduced in Chromium against 0.1.3; now one `PAGE_REPORT` per frame, applied one at
  a time per tab.
- **An iframe reset the whole tab.** Every frame reported its own URL as the page's, so an embedded
  player or an ad frame looked like a navigation and wiped the tab's media, back and forth. Only the
  top frame now says which page the tab is on; sub-frames contribute media and DRM/MSE signals.
- **Pausing a direct download did not pause it**, and Resume then started a second copy of the same
  file. Direct files are now paused and resumed by the browser, which keeps the partial file.
- **Pausing an HLS/DASH download while its manifest loaded restarted it** a moment later. Any error
  from an attempt the user stopped is now treated as the stop it was.
- **A lone HLS media playlist could not be downloaded** ("A segmented download requires a selected
  variant"). A media playlist found without a master is now its own rendition.
- **"Scan again" scanned before the page had re-reported.** The worker now waits for the top frame's
  fresh report before scanning.
- A new page's early media requests were dropped when its first report arrived; the network observer
  now starts a page at the document request itself.
- A segmented download kept fetching every remaining segment after one had failed for good, although
  the result is always refused; it now stops at the first hole. Up to 1.5 GB of wasted transfer.
- A cancelled download showed a network error when the browser then reported it interrupted.
- Download-complete notifications were silently tied to the "keep history" setting.
- The assembled blob leaked when handing it to the browser failed.
- A tab that closed mid-report could have its record written back after it was forgotten.

Found by the independent re-audit of the changes above, and fixed before release:

- A link that downloads a file, a 204, or a prerendered page reset the tab's network media, although
  the visible page never changed. Only a top-frame response that becomes the page starts a new one; a
  prerendered page's content script stays silent until the page is shown.
- A fragment change (`#t=90`, an anchor, hash routing) was treated as a navigation and dropped an
  embedded player's media, and "Scan again" only re-asked the top frame. Fragments are ignored and
  every frame re-reports.
- A direct download paused in the browser was orphaned when Chrome stopped the idle worker (about
  30 s): the row vanished and the partial file was untracked. Browser-paused downloads are now kept in
  session storage and adopted again, if the browser still has them.
- "Scan again" ran two full scans back to back when auto-scan was on; it now joins the scan its own
  report started.
- Cancelling in the instant after the last segment arrived could still open a Save dialog.
- A failed start of the download manager was cached for the life of the worker.

And by the verification pass over those fixes:

- A link to a file the browser downloads because of its type (a `.zip` served as `application/zip`,
  with no `attachment` header) still reset the page; only content types the browser shows as a page
  now start one.
- A prerendered page's requests were filed under the page on screen, then lost when it was shown.
  They are now kept per prerendered page and adopted if the user navigates to it.
- "Scan again" could reuse a report built before it was asked; it now joins only the report made for
  that request (one request id for its two messages).
- A download paused in MediaGrab and then resumed from the browser's own download list, while no
  worker ran, came back as "paused" and failed on Resume; it now comes back as downloading.

### Changed

- `background/index.ts` is now only the composition root. Its jobs moved to `tab-store.ts`,
  `scanner.ts` (one scan per tab in flight, one shared follow-up), `message-router.ts`, `services.ts`
  and `download-hooks.ts`.
- `downloads/manager.ts` keeps the queue, states and retries; request building moved to
  `task-factory.ts`, fetching to `engines.ts` behind a `DownloadEngine` interface, and browser progress
  polling to `browser-progress.ts`. `concurrentDownloads` now counts every download in flight, direct
  files included.
- One manifest fetcher (`core/fetch.ts` `fetchManifestText`) replaces two copies that had drifted.
  Manifest HTTP errors are classified like segment errors (404 is `MEDIA_NOT_FOUND`, not retried).
- Nothing outside `src/browser/` touches `chrome.*` any more (network observer, assembly host and
  offscreen document went through it directly). `BrowserApi` gained `downloads.pause/resume`,
  `webRequest.isAvailable`, `offscreen` and a `frameId` option on `tabs.sendMessage`.
- The worker accepts `PAGE_REPORT` only from content scripts and everything else only from its own
  pages.
- Progress updates to open popups are batched to at most four a second.
- `ScanStats.domElements` is now `mediaElements` and counts `<video>`/`<audio>` elements, which is what
  the diagnosis always assumed.

### Removed

- Eight settings nothing read (`defaultQuality`, `preferredFormat`, `scanAfterPlay`, `floatingButton`,
  `preferHighestQuality`, `downloadSubtitles`, `downloadThumbnail`, `telemetry`). Stored values are
  ignored. There is still no telemetry of any kind.
- The unimplemented `stream-copy` strategy, `priority`, `audioUrl`, `audioVariantId`, the `deep` scan
  flag, unused exports, and the Referer plumbing that `fetch` always dropped.

### Tests

- 177 unit tests (was 131): the manager through fake engines, frame-report folding, per-tab
  serialisation, scan coalescing, sender rules, the navigation boundary, manifest error classes,
  fail-fast segments, best-rendition choice, adopting paused downloads after a restart.
- 34 Playwright tests (was 29). New against the real extension: media only in the DOM, a page with an
  embedded player, "Scan again" with fresh DOM state, pause and resume of a direct download with
  exactly one file, and a fragment change on the embedded-player page. The first, second and fourth
  fail against 0.1.3.

## [0.1.3] — 2026-09-09

### Added

- **A preview image beside every media row.** 76×43, between the confidence meter and the title, so it
  aids recognition without becoming the row. Three same-size states — the poster, a placeholder with a
  `▶`/`♪`/`CC` glyph and the container name, and the same placeholder when an image fails to load — so
  the list never reflows and a missing poster never reads as a broken extension.
- **Poster back-fill** (`src/media/poster.ts`). Only a `<video>` element carries a poster, but the
  candidate a user usually wants is the HLS or DASH manifest found by the network observer, which sees a
  URL and two headers. Without this, the row most likely to be downloaded was the one row with no
  picture. A candidate now inherits a poster from a player on the same page, or from the page's
  `og:image` / `twitter:image` / JSON-LD thumbnail — never across pages, never over a poster it already
  has, and never from a `data:` URL.
- `pagePoster` threaded from the DOM scan through `PAGE_CONTEXT` to the engine.
- Six unit tests for the back-fill, three UI tests (image loads, placeholder falls back, rows keep the
  same height), and an extension test asserting a network-found HLS candidate ends up with a poster.

### Fixed

- The placeholder label sat at 4.24:1 against the sunken ground — `--ink-faint` is tuned against
  `--ground`, not `--ground-sunken`. Caught by axe; now uses `--ink-muted`.

### Notes

- The preview loads a remote image from an extension page. It is one the page already loaded, and it is
  requested `no-referrer` and `lazy`. See SECURITY.md § 5b.
- `design/IDENTITY.md` rejected thumbnails as the *primary* visual and still does; the reasoning for
  admitting a small secondary one is recorded there rather than left contradicting.

## [0.1.2] — 2026-09-09

Reported from a real install: Chrome warns *"You need to request host permissions in the manifest file
in order to be notified about requests from the webRequest API."* The warning was correct, and the
underlying problem was worse than cosmetic.

### Fixed

- **`webRequest` was declared but could never fire.** With no host permissions at install, a
  `webRequest` listener receives nothing — verified by loading the shipping build with nothing granted
  and watching a page load produce no scan at all. The network observer was dead weight until a grant,
  and Chrome warned the user about it on every install.
- `NetworkObserver.start()` registered for `<all_urls>` at boot regardless of what was granted. It now
  takes the granted origin patterns, is a no-op when there are none, and is re-run whenever a grant
  arrives.
- Observer registration is wrapped so it can never abort `boot()`. It ran *before* the message-handler
  registration, so a throw there would have left the popup with a background worker that never answers.

### Changed

- `webRequest` moved to `optional_permissions` on Chrome and is requested together with the first site
  grant, in the same click. A fresh install now declares no host permissions and no `webRequest`, so the
  warning is gone and the install prompt matches what the extension can actually do.
- Firefox keeps `webRequest` static: that build has never been run, and this was not the change to find
  that out with.
- Anyone who granted origins before this version is asked once more, because they do not yet hold
  `webRequest`.

### Added

- Four tests that load the **shipping** build — the configuration `chrome-test` deliberately cannot
  cover — and assert it installs with no host permissions and no `webRequest`, declares `webRequest` as
  optional, boots without complaining, and still answers the popup.

## [0.1.1] — 2026-09-08

First re-audit. The headline is that the extension is now **verified working in a real browser** — and
that verifying it immediately found a bug that broke every segmented download on Chrome.

### Added

- **A real-extension test suite (12 tests).** Loads the built extension into a real Chromium and points
  it at a local fixture site serving a video page, an HLS master with three renditions, a DASH MPD with
  video and audio representations, a Widevine-protected MPD, an advert and a poster. It asserts
  detection, ladder expansion, scoring, DRM refusal, and that progressive, HLS and DASH downloads all
  complete with exact byte counts.
- **A `chrome-test` build target** (`node scripts/build.mjs chrome-test`), the shipping Chrome build plus
  the two manifest lines a scripted browser needs: host permissions for 127.0.0.1 and a declarative
  content script. Never published; `pnpm test:e2e` rebuilds it so it cannot go stale.
- Byte-level progress for direct downloads, polled from `chrome.downloads`.
- Duplicate collapsing: two download requests in the same turn join one task.
- `tabs.onRemoved` cleanup for per-tab detection state.
- `downloads.search`, `tabs.onRemoved` and `runtime.openOptionsPage` in the browser abstraction.

### Fixed

- **Every HLS and DASH download failed on Chrome.** `const doFetch = options.fetchImpl ?? fetch`
  detached `fetch` from its receiver; a service worker tolerates that, but the offscreen document is a
  Window and threw `Failed to execute 'fetch' on 'Window': Illegal invocation` for every segment. Fixed
  at all three call sites via `boundFetch`, with a unit test asserting the receiver is `globalThis`.
  Unit tests could not have caught this: they always inject a `fetchImpl`.
- Direct downloads showed no progress at all — `downloads.onChanged` reports state, not bytes.
- Segment failures were unclassified: "5 of 5 segments could not be downloaded" with no reason. The
  first failure's code, message and URL now propagate out of the offscreen document to the task, and the
  HTTP classification is preserved instead of collapsing to `SEGMENT_FAILED`.
- `NetworkObserver.forgetTab` was never called, leaking per-tab state and session-storage keys for the
  whole browser session.
- `DownloadManager.prune()` was never called, so completed tasks accumulated in memory forever. It is
  now called lazily from `list()`, which suits a worker that is killed constantly.
- `duplicateOfExisting` was dead code (written, unit-tested, never called), against CHARTER § 2.
- The popup's Settings button used `window.open`, stacking up tabs and ignoring `options_ui`.
- `recordCompleted` took a parameter it discarded.

### Changed

- **`Referer` is no longer pretended.** It is a forbidden header name that `fetch` silently drops, so
  the replay SECURITY.md described never happened. The no-op header is removed from all three fetch
  sites, `RequestContext` documents that its values are recorded but not sent, and an extension test
  pins what actually reaches the server. Making the replay real needs a `declarativeNetRequest` rule.

## [0.1.0] — 2026-09-07

First build. Detection, intelligence, manifest parsing, the download engine, the popup and the options
page. Not released to any store.

### Added

**Detection**
- DOM scanner covering `<video>`, `<audio>`, `<source>`, `<track>`, posters, `data-*` lazy-load
  attributes, `og:video` / `twitter:player:stream` meta tags, JSON-LD `VideoObject`/`AudioObject`, and
  media links; every page-owned property read is wrapped so a throwing getter cannot abort a scan.
- MAIN-world page hook instrumenting `fetch`, `XMLHttpRequest`, `MediaSource.addSourceBuffer`,
  `URL.createObjectURL` and EME (`setMediaKeys`, `requestMediaKeySystemAccess`), reporting through a
  namespaced `postMessage` envelope and never touching request or response bodies.
- Background network observer using observe-only `webRequest.onResponseStarted`, reading only
  `Content-Type` and `Content-Length`, with per-tab caps and segment-URL suppression.
- Detection engine orchestrating collect → adapter → manifest expansion → dedupe → score → rank →
  diagnose.
- `Diagnosis` codes and copy replacing "no media found": `DRM_PROTECTED`, `MSE_ONLY`, `NOT_STARTED`,
  `CROSS_ORIGIN_FRAME`, `UNSUPPORTED_PLAYER`, `NO_MEDIA_YET`.

**Manifests**
- HLS parser (RFC 8216): master and media playlists, quote-aware attribute tokenizer, `EXT-X-MEDIA`
  renditions, `EXT-X-MAP`, `EXT-X-BYTERANGE` with rolling offsets, `EXT-X-KEY` with DRM classification,
  I-FRAME stream exclusion, live detection.
- DASH parser (ISO/IEC 23009-1): a dependency-free XML reader that rejects DTD/ENTITY declarations,
  ISO 8601 durations, hierarchical `BaseURL`, adaptation sets and representations, `ContentProtection`
  DRM detection.
- Segment plan builders for all four DASH addressing modes and for HLS, including `$Number%05d$`-style
  template expansion and `SegmentTimeline` repeats.

**Intelligence**
- URL normalization stripping volatile query parameters, and FNV-1a fingerprinting so one asset behind
  three signed URLs is one entry.
- Union-merge de-duplication where a measured size beats an estimated one and each source contributes
  what it knows.
- A 0–100 candidate score with human-readable reasons for every point, and a separate quality score that
  weighs codec efficiency and audio bitrate so 4K with thin audio does not beat 1440p with good audio.
- Best / balanced / smallest recommendations, quality-rung labelling, and HLS audio-group pairing.
- Filename template engine (`{title} {domain} {date} {time} {quality} {resolution} {format} {codec}
  {language} {index} {ext}`) with traversal-proof sanitization, Windows device-name escaping, and
  site/date folder organisation.

**Downloads**
- A queue with a strict state machine, concurrency limits, retry with classification, and pause/cancel.
- Two engines: the browser's own downloader for direct files, and a segment fetcher for HLS/DASH with
  ordered assembly, bounded adaptive concurrency (1–8), full-jitter backoff, and `Retry-After` support.
- Offscreen-document assembly on Chrome (an MV3 worker has no `createObjectURL`), in-place on Firefox,
  chosen by feature detection.
- EWMA speed smoothing and ETA, plus segment-count progress when byte totals are unknown.
- Twelve classified error codes with user-facing copy, replacing generic failure messages.

**Product**
- Popup with a "Best download" primary action, a media list ordered by score with a signal meter,
  an expandable quality ladder, a downloads view, and a Simple/Power mode split.
- Options page covering site access, general, downloads, privacy and local history.
- Per-origin optional host permissions with an in-popup grant flow; no `<all_urls>` at install.
- Context menus, three configurable keyboard commands, and a completion notification.
- Clipboard-only, fully redacted diagnostics export.

**Engineering**
- `BrowserApi` abstraction; nothing outside `src/browser/` touches `chrome.*`.
- Adapter contract, registry and a generic adapter that boosts the rendition matching the page's main
  player duration.
- One build script producing `dist/chrome` and `dist/firefox` from one source, with a generated manifest
  and PNG icons drawn at build time by a hand-written encoder (no image dependency).
- Dynamic content-script registration for granted origins only (no declarative `<all_urls>` block), with
  idempotent on-demand injection right after a grant so detection works before a reload.
- `_locales/en/messages.json` backing the manifest name, description and command labels.
- UI dev harness with an in-memory browser fake, on port 5177.
- 124 unit tests, 10 Playwright UI tests including axe in light and dark mode.

### Decisions that depart from the brief

- **Svelte 5 instead of React + Zustand + Tailwind.** Smaller popup, no runtime shipped, one toolchain
  across the monorepo, and the state and styling libraries buy nothing at this size.
  `ARCHITECTURE.md` D1 has the full reasoning and the cost of reversing it.
- **Remote signed adapters are not implemented.** The contract and registry ship; runtime-loaded code
  in an extension with `downloads` permission needs a signing key, verification, revocation and review
  before any of it is safe. `ARCHITECTURE.md` D7.
- **No muxing and no decryption.** Both are refused with clear errors rather than producing broken
  files. `README.md` § Known limitations.

### Fixed during development

- DASH `$$` escape was unreachable because the variable pattern required a trailing `$`.
- Size bucketing was a no-op: the divisor scaled with the input, so every value was its own bucket.
- Filename sanitization left interior `..` runs after separator removal.
- The DRM row was dimmed with `opacity`, dropping its explanation to 3.1:1 contrast.
- Dark-mode faint text sat at 3.58:1.
- A manifest with no resolution of its own scored below a 720p progressive file, because the parent
  candidate's blank metadata was scored instead of its best rendition.
- `default_locale` was declared with no `_locales/` subtree, which makes Chrome refuse to load the
  extension.
- The content script was never registered or injected anywhere, so DOM detection could not have run.

[Unreleased]: https://example.invalid/compare/v0.1.6...HEAD
[0.1.6]: https://example.invalid/compare/v0.1.5...v0.1.6
[0.1.5]: https://example.invalid/compare/v0.1.4...v0.1.5
[0.1.4]: https://example.invalid/compare/v0.1.3...v0.1.4
[0.1.3]: https://example.invalid/compare/v0.1.2...v0.1.3
[0.1.2]: https://example.invalid/compare/v0.1.1...v0.1.2
[0.1.1]: https://example.invalid/compare/v0.1.0...v0.1.1
[0.1.0]: https://example.invalid/releases/tag/v0.1.0
