# MediaGrab — second code-and-flow audit, SOLID simplification, re-audit

**Date** 2026-09-25 · **Package** `media-grab/` v0.1.4 → v0.1.5 · **Scope** every module under `src/`,
the build's manifest generator, and the tests. The first pass (report `2026-09-25-solid-audit.md`) read
the parsers, the media rules and the UI "for contracts, not line by line"; this pass read them line by
line, and re-read everything the first pass restructured.

Decided by engineering under owner delegation: the request named no package, so the audit continued
with the package worked on last. Every decision below that changed behaviour is logged in
`media-grab/ARCHITECTURE.md` (D13–D15) and `media-grab/CHANGELOG.md` (0.1.5).

---

## 0. Baseline

| Check | 0.1.4 |
|---|---|
| Unit tests (Vitest) | 177 / 177 pass |
| Playwright (13 UI + 21 extension in real Chromium) | 34 / 34 pass |
| Typecheck (svelte-check + tsc), lint (Biome), knip | clean |

The source was snapshotted before any change (the repository has no commits, so no git undo); the
snapshot is also what the new browser tests were run against to prove the bugs were real.

## 1. Pass 1 — findings

Three auditors, each with a disjoint slice and no part in the code: the detection flow (page to popup),
the pure parsers and media rules, and the UI/platform layers. Every finding had to be verified by
reading the code path or by a scratch script that imports the real module; anything unproven was
dropped. Totals: **68 bugs** (5 High, 30 Medium, 33 Low; 17 detection, 23 parsers and media rules,
27 UI and platform, and one the lead found in the download manager) and **38 design-debt items**.

The Highs:

| # | Where | What went wrong for a user |
|---|---|---|
| A1 | page hook → content script | On an hls.js page every `.ts`/fMP4 segment became its own row; "Best download" could save one 6-second segment. |
| A2 | DOM scan, format rules | Every MediaSource player listed `blob:` URLs as downloads and hid the "the player assembles this in JavaScript" explanation. |
| B1 | `media/naming.ts` | A title of 109+ characters produced `…[1080p].mp` or a name with no extension; a cut could split an emoji. |
| B2 | `media/dedupe.ts` via the manager | A different video that shared a file name (`/v/222/1080p/index.m3u8` while `/v/111/1080p/index.m3u8` ran) was refused as a duplicate; so was every other DASH rendition of the manifest being downloaded. |
| C1 | `permissions/site-access.ts` (Firefox) | "Enable on this site" and "Allow on all sites" silently did nothing: the request named a permission Firefox declares as required, which rejects the whole request. |

The Mediums cluster into six causes, which is what the restructuring was aimed at:

1. **The detectors could not see the page.** A site grant is one host, so manifests on a CDN were
   invisible to the network observer; the page hook was injected after `DOMContentLoaded` (after most
   players fetch their manifest) and its XHR check never ran (A3, A4, C8).
2. **"Is this a new page?" was answered from URLs.** A `replaceState` tidying tracking parameters threw
   away the manifest; a pushState route kept the old route's media; a back-forward-cache restore showed
   the next page's media (A5, A6, A11).
3. **Four rule sets for "is this URL media?"** that disagreed, only one of which knew about segments
   (A1, A8, AD1).
4. **Identity from the wrong fields**: candidate ids that changed during a candidate's life (A7);
   dedupe keys that dropped the query (B8); duplicates by file name (B2); variant ids from signed URLs.
5. **The file's container was decided before anyone knew it**: every HLS rendition saved as `.ts`
   (B11); DASH on-demand files written with their init twice and fetched as one 60-second segment (B3,
   C4); streams too long to assemble silently truncated (B16).
6. **The popup's logic lived in a component the harness skipped** (C2, C17, C18, CD1).

The DASH parser was the densest single cluster (B3–B6, B13–B15): a 100-line nested loop that filled
defaults before merging inheritance, so any Representation-level template under an AdaptationSet
template came out wrong.

## 2. What changed

### 2.1 Structure (SOLID)

| Before | After | Principle |
|---|---|---|
| Page hook: five hand-rolled patches, a `<script>` tag injected late, a web-accessible file | `wrapMethod` (one Proxy rule for every patch); registered as a MAIN-world content script; `core/hook-protocol.ts` shared by both ends | SRP, DRY |
| Content script sent finished `MediaCandidate` objects, shape-checked on two fields | Sends `ReportedCandidate` claims; `core/messages.ts` allow-lists them field by field; `detection/candidate.ts` is the one place a candidate is built | trust boundary, SRP |
| Four media-URL rule sets | `classifyMediaUrl` (kind, protocol, format, isSegment) used by the hook, DOM scan, content script and network observer | DRY |
| Caps scattered as bare numbers | `core/limits.ts`: every cap on page input with its reason | readability |
| Navigation = "the top frame's URL changed" | `routeStartedAt` stamped by the content script; tab store and network observer cut at it | correctness |
| Engine: normalize → expand → dedupe | collect → dedupe → normalize → expand (`ManifestCache`, 30 s) → fold nested playlists → rank | SRP, fewer fetches |
| `manifest-loader` fetched and attached in one call | `loadManifestDetails` (pure data) + `withManifestDetails` | SRP, cacheable |
| HLS parser: 15 fields nothing read | trimmed to what is read; parse errors classified | YAGNI |
| Two DRM tables, three URL resolvers (one with the arguments reversed), two segment caps (both truncating) | `manifests/drm-systems.ts`, `manifests/url.ts`, `segment-plan.ts` `assertPlanSize` (refuses) | DRY |
| DASH `parse.ts`, 357 lines, one nested loop | `model.ts` (discriminated addressing union), `segment-info.ts` (inherit, then default), `parse.ts` (Period → AdaptationSet → Representation), `segments.ts` (one function per mode, bigint timeline) | SRP, illegal states unrepresentable |
| Filename fixed at enqueue | `EngineRun.rename(extension)` → the manager rebuilds the name with `filenameFor` once the plan says what the file is | OCP |
| One `retryCount` driving two nested loops | `DownloadEngine.retriesItself`; `downloads/retry.ts` shared by segment and playlist fetches | DIP, no hidden coupling |
| Browser download events as positional strings | `DownloadChange` (with `paused`); `interrupt-reasons.ts` maps the browser's reasons | clarity |
| Popup: 150 lines of logic in `Popup.svelte`, skipped by the harness | `ui/lib/popup-controller.ts` (plain TS, unit-tested), `bridge.ts`, `download-view.ts`, `media-view.ts`; the component renders | SRP, testability |
| Pause offered by strategy name in the UI | `DownloadTaskView.pausable`, set from the engine | OCP |

Removed as dead: `requestContext`, the `manifest`/`iframe` sources, `LOGIN_REQUIRED`, `concatParts`,
`duplicateOfExisting`, `expandManifest`, vendor sniffing, the unused `__TARGET__` define, the download
badge, eight parsed-and-never-read HLS fields and several DASH ones. knip reports nothing.

### 2.2 How the work was split

The three largest independent clusters went to three engineers working on disjoint files at the same
time (DASH parser; media rules; UI and storage), each required to add a regression test per bug and to
mutation-check the important ones. The detection flow, the download pipeline, the HLS side and all
integration were done by the lead. Parallelism stayed inside this one package.

## 3. Proof, not just tests passing

- **Real-browser reproduction against 0.1.4.** Ten new extension-test fixtures, each with exactly one
  way for its media to be found (so one detector cannot cover for another — the lesson of the first
  pass), were run against the untouched 0.1.4 build. **All ten fail there for the reason their bug
  predicts** (e.g. `Received: "MediaGrab/Deep Sea Documentary [1080p].ts"`; `old route media kept`;
  `Expected "NOT_STARTED", Received "DRM_PROTECTED"`) and pass on 0.1.5. They include a second host,
  `[::1]`, that the test build holds no grant for, standing in for a CDN.
- **Mutation checks.** DASH: 21 mutants, all caught. Media rules: B1, B2, B8, B17, B19 each fail their
  tests when the fix is reverted. UI: C1, C2, C12, C13. Re-audit Highs: the Firefox pause and the
  audio-row fold each fail their tests when reverted.

## 4. Pass 2 — independent re-audit

Three reviewers who had written none of the code: detection-flow correctness, download/parser/UI
correctness, design and readability.

**Design verdict:** "The refactor improves the code. Each new module does one job and says so in its
header… `chrome.*` is only touched inside `src/browser/`, and knip reports no dead code." 18 findings,
one High (the new specific error messages never reached the user — the row showed only generic copy),
plus a checklist of 30 stale statements in the docs. All acted on except RD15 (typed message replies)
and RD17 (test-name tags), which are churn without a user-visible gain; RD16 (move the fake browser)
and RD6 (move `isInFlight` into the UI) were answered by correcting the headers that misdescribed them,
since `isInFlight` is a rule about states and belongs beside `isActive`.

**Correctness: 29 findings, two High — both regressions introduced by this pass, both fixed:**

| # | Sev | Finding | Fix |
|---|---|---|---|
| RB1 | High | Firefox implements Pause as an interruption (`interrupted`, `USER_CANCELED`, `paused: true`); the new interrupt mapping read that as a cancel and deleted the partial file. | `DownloadChange.paused` forwarded; an interruption that is a pause (or that the browser says is paused) is a pause. Pausing/resuming from the browser's own list is now followed too (RB9). |
| RA1 | High | The new "fold playlists a master lists" step also dropped the master's audio playlists, so separate audio could not be downloaded at all. | Renditions and subtitles fold; audio playlists stay, relabelled as audio rows. |
| RA2 | Med | The hook counted segments toward its 500-URL memory and then went silent for the route. | Segments skipped first; oldest evicted. |
| RA3 | Med | "Scan again" request ids restarted at `scan-1` with every worker, so a frame could answer with an old report. | `crypto.randomUUID()`. |
| RA4 | Med | Every worker wake unregistered and re-registered both content scripts, leaving a gap in which a loading page got neither. | Unchanged registrations are left alone. |
| RA5 | Med | After leaving a granted site for one MediaGrab cannot read, the shortcut and context menu downloaded the previous site's best video. | The stored scan must be of the page on screen. |
| RA6 | Med | DOM claims accumulated within a route, so a router that changes the URL before rendering kept the old route's media. | DOM claims re-read every report; fetched URLs accumulate. |
| RB2 | Med | With the segmented engine retrying per segment, one transient playlist failure failed the whole download; direct files were never retried. | The playlist fetch is retried; retryable browser interruptions requeue. |
| RB3 | Med | = RD1: specific errors never shown. | Headline + detail. |
| RB4 | Med | Multi-Period DASH was cut to its first Period (often an advert). | Refused at download time. |
| RB5 | Med | A manifest's own Content-Length ("3 KB") was shown as the video's size and used as the progress total. | Ignored for manifests. |
| RB6–RB15, RA7–RA14 | Low | Init-switch edge cases, byte-range offsets across gaps, a 200 for a whole-file range, Firefox Save-As cancel, `{ext}` in templates and the byte cap after a rename, final progress of a finished file, a vanished quality silently swapped for "best", short signature parameters in redaction, `<source>` types overwritten by `currentSrc`, `seenAt` not refreshed, report size budget, lazy-load selector, `blob:` of a finished Blob diagnosed as MSE. | All fixed except as listed in § 6. |

## 5. Final state

| Check | 0.1.4 | 0.1.5 |
|---|---|---|
| Unit tests | 177 | **380**, all pass (18 files) |
| Playwright | 34 (13 UI + 21 extension) | **52** (22 UI + 30 extension), all pass |
| Typecheck, lint, knip | clean | clean |
| Background bundle, gzip (budget 40 KB) | 29.1 KB | 34.5 KB |
| Content script (15 KB) | 6.6 KB | 7.3 KB |
| Page hook (3 KB) | 1.0 KB | 2.5 KB — closest to its budget; see PERFORMANCE.md |
| Popup JS (60 KB) | 26.6 KB | 29.4 KB |
| Unpacked extension (500 KB) | 207 KB | 234 KB |

### 5.1 Verification round

The two correctness reviewers re-checked every one of their findings against the fixed tree.

- **Detection (RA1–RA14):** 9 fixed, 2 partly (RA5, RA12), 1 fixed with a trade-off (RA14), 4 left as
  documented limits (RA8, RA9, RA11, RA13 — now README "Known limitations" 12–15). Three new Low issues
  from the fixes: the shortcut did nothing after a `replaceState` (now: the shortcut asks the page for
  a fresh report, the same path as "Scan again", and only gives up if the page still differs); a
  played-then-removed `<video>` lost its title and poster (now kept for the route when its URL was
  fetched); the per-frame cap could push out the `<video>` claims (now ordered media elements, then
  fetched URLs, then links). The RA14 trade-off (MSE diagnosis lost when the hook arrives late) was
  reverted: a `blob:` src is an MSE signal again.
- **Downloads (RB1–RB15):** 11 fixed, 4 partly, and three new issues from the fixes, all fixed:
  **a paused download cancelled from Firefox's Library turned back into "downloading"** (Medium: that
  cancel changes only `paused`; the manager now asks the browser before treating it as a resume); **a
  server ignoring Range had each whole file read into memory before the refusal** (Medium: decided from
  the headers now, body cancelled unread); the error detail showed a signed segment URL (redacted).
  The partial ones are finished too: single-file DASH variants from a multi-Period MPD go through the
  refusing path; separate audio tracks are selectable in the row and the router; a finished file too
  small to be polled takes its size from the browser; `md5` is a volatile parameter.

Both Mediums were mutation-checked (their tests fail with the fix reverted). Final run: lint, typecheck,
knip clean; 380 unit and 52 Playwright tests pass.

## 6. Still open, stated plainly

- **Separate audio is still a separate download.** There is no muxer; a video-only rendition says
  "no sound", and its audio can now be downloaded from the row, but the two are not joined.
- **Session storage per tab has no byte cap** (each report is capped). Only a hostile page with many
  frames could approach the 10 MB quota.
- nginx secure_link's path form (`/s/<hash>,<expiry>/`) is not redacted; its query form is.
- **Hash-routed apps** (`#/video/2`) are not treated as route changes; a **query-only pushState** is, so
  a persistent player's manifest can drop out of the network observer after one (the page hook and
  Resource Timing still hold it). The Navigation API is not hooked.
- **Players in about:blank / srcdoc iframes** and **players running in a Worker** are invisible to the
  page hook and Resource Timing.
- **A content script injected late** (right after a grant) treats the whole document life as the
  current route.
- **Firefox has still never been run.** Its pause semantics, `world: 'MAIN'` registration, Resource
  Timing in the content-script sandbox and the `hello` replay are implemented from its documentation and
  source, and unit-tested against fakes of that behaviour only.
- Carried over from the first pass: the download queue does not survive a worker restart (except
  browser-paused direct files); a download that finishes while no worker runs is not written to history.
- **No git history.** The repository has no commits, so this change cannot be reviewed as a diff by
  anyone but the snapshot holder. Committing is the owner's call.
