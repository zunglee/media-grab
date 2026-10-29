# MediaGrab — extensive specification

Living document. Section 8 is the hand-off ledger between work sessions and is kept brutally honest.

Version 0.1.6 · last updated 2026-09-25

---

## 1. Product vision

A cross-browser extension that finds the downloadable audio and video on the page you are looking at,
shows you the real quality options, and downloads them — without ever circumventing DRM, paywalls,
sign-in, or any other access control.

The category is full of tools that show you a list of URLs and make the ranking your problem, ask for
permission to read every site you visit, and say "no video found" when they fail. MediaGrab's bet is
that measuring, explaining and asking narrowly is a better product, not just a more ethical one.

## 2. Product goals

1. **Right file, one click.** "Best download" is correct often enough that most people never open the
   quality ladder.
2. **Truthful failure.** When it cannot help, it says which of the six reasons applies and what to try.
3. **Narrow permissions.** No host permissions at install; one origin at a time, from a click.
4. **Nothing leaves the machine.** No backend, no telemetry, no analytics containing URLs.
5. **Maintainable breadth.** A generic engine plus an adapter layer, so site coverage grows without the
   core learning any site's name.
6. **Both audiences.** Simple mode for people who want a video; Power mode for people who want AV1.

## 3. Non-goals

- Removing DRM, defeating paywalls, or authenticating on the user's behalf. Permanently out of scope.
- Being a general download manager for non-media files.
- Screen or tab recording as a fallback. Considered (brief § 32), deferred: it is a different product
  with different consent requirements and it does not belong behind the same button.
- A cloud queue, a remote download target, or a NAS integration in v1.
- Claiming "every website". The honest claim is a generic engine plus a documented compatibility list.

## 4. Target audience

- **Primary — the offline viewer.** Wants a lecture, talk or episode for a flight. Does not know or care
  what HLS is. Judges the product on whether the first button was right.
- **Secondary — the archivist.** Saving conference talks or course material at the best quality
  available. Cares about codecs, bitrates, subtitles and filenames, and will use templates and folders.
- **Tertiary — the developer.** Wants to see what a page is actually requesting. Power mode and the
  diagnostics export exist partly for them.

## 5. Brand identity

Full treatment in [design/IDENTITY.md](design/IDENTITY.md). In one line: **SIGNAL** — a page is a set of
media signals of varying strength and the extension is the instrument that reads them. Warm near-black,
one amber accent used only for the action, monospaced numerics, hairline rules, a five-segment level
meter on every row, and no gradients, glass or entrance animation anywhere.

## 6. UX philosophy

- **One primary action.** "Best download" is the only filled button on the screen.
- **Progressive disclosure.** Ladder behind a disclosure; codecs and scores behind Power mode.
- **Explain, do not apologise.** Every failure state names its cause and offers the next step.
- **Never hide, only rank.** Filtered candidates stay in the result with their reasons attached.
- **Ask narrowly, and say what it costs.** The permission prompt names the origin, and the UI states the
  reload consequence rather than hiding it.

## 7. Feature inventory

**Detection** — DOM elements and attributes · lazy-load `data-*` · `og:` and Twitter player meta ·
JSON-LD `VideoObject` · media links · network responses (granted hosts) · page-context `fetch`/`XHR`
(extensionless manifests by type) · Resource Timing (any host) · `MediaSource` signal · MediaKeys
(DRM) signal · single-page-app route changes · HLS master and media playlists · DASH MPDs · embedded
player frames.

**Intelligence** — URL normalization · fingerprinting · exact and near-duplicate merging · 0–100 scoring
with reasons · quality scoring across resolution, bitrate, codec efficiency, frame rate and audio ·
quality-rung labelling · best/balanced/smallest recommendations · audio pairing · diagnosis.

**Downloads** — first-in-first-out queue · concurrency limit · state machine · retry with classification ·
pause/resume/cancel (pause for direct files; followed from the browser's own download list) ·
browser-download engine · segment engine with adaptive concurrency capped at the user's setting and
jittered backoff · ordered assembly · container settled by the playlist (.ts / .mp4 / .m4a / .aac) ·
progress with EWMA speed and ETA · duplicate detection per rendition.

**Product surface** — popup with media and downloads views · per-row preview image with placeholder
fallback · quality ladder · Simple/Power ·
diagnosis panel · options page · local history with day grouping · filename templates and folder rules ·
per-origin permissions · context menus · three keyboard commands · completion notifications ·
clipboard-only redacted diagnostics.

**Not in this build** — muxing · decryption · live capture · recording · subtitle and thumbnail
download · batch selection · playlist detection · site adapters · remote adapters · UI translation ·
sidebar · phone transfer · NAS · scheduler · download rules · AI detection.

## 8. Current implementation status

**Done** (built, working, tested)

- HLS parser, DASH parser, XML reader, ISO 8601 durations, segment plan builders for HLS and all four
  DASH addressing modes.
- Fingerprinting, URL normalization, union-merge de-duplication, candidate scoring, quality scoring,
  ladder labelling, recommendations, audio pairing.
- Filename template engine with traversal-proof sanitization and folder organisation.
- Download state machine, progress tracking, segment fetcher (ordering, retries, backoff, `Retry-After`,
  abort, credential omission), assembler with hole detection.
- Message protocol with validation, redaction, settings merge/clamp, history storage and grouping.
- Browser abstraction; Chrome and Firefox manifests generated from one source; both builds produced;
  content script registered dynamically for granted origins only, with on-demand injection after a grant.
- `_locales/en/messages.json` backing the manifest's name, description and command labels.
- Popup, options page, dev harness, design system, light and dark themes at AA contrast.
- 560 unit tests, 27 UI tests including axe in both schemes and on the Downloads view, 45 tests
  driving the real extension in a real Chromium, worker death and a simulated update among them. Lint,
  typecheck and knip clean.
- Per-row preview images, with poster back-fill so network-found manifests are not the one row with no
  picture, and a labelled placeholder when there is no poster at all.
- **Verified in a browser (2026-09-08):** detection of a progressive file, an HLS ladder and a DASH
  manifest on a live page; advert and poster filtered; DRM detected and refused; progressive, HLS and
  DASH downloads all completing to disk with exact byte counts; duplicate requests collapsing.
- **Permission model verified (2026-09-09):** the shipping build installs with no host permissions and
  no `webRequest`, boots cleanly, and still answers the popup. `webRequest` is optional on Chrome and
  granted with the first site; the observer is registered for granted origins only.

**Partial** (works, with a stated gap)

- **Download manager** — direct files and single-stream HLS/DASH renditions download end to end. Direct
  files pause and resume in the browser; a segmented download offers only Cancel. The queue survives a
  worker restart (D16); after an update or browser restart only browser-held files are followed again.
  Split streams download as two files (video, audio); there is no muxer.
- **Firefox** — experimental (D19): builds, never run. Playwright cannot load extensions into Firefox.
- **Detection against the real web** — verified against a local fixture site that behaves like a real
  video page, but not against actual third-party sites.
- **Site adapters** — contract, registry and the generic adapter exist and run. No site-specific adapter
  is bundled.
- **Subtitles** — detected, parsed and carried on the candidate; the UI does not yet offer to download
  them. Posters are now shown as the row preview but still cannot be saved as files.
- **Live streams** — detected, marked live and not saveable (D21); no recording mode.
- **DASH multi-period** — listed, marked "several parts" and not saveable (D21).
- **Pause on a segmented download** — cancels rather than pausing; there is no partial file to resume
  into.

**Not started**

- Muxing separate audio and video. Decryption of AES-128 HLS. Recording mode. Batch selection and
  playlist detection. Download rules. Scheduler and bandwidth limits. Remote signed adapters. UI
  translation (the manifest is localised; the UI is not). Sidebar. Phone transfer, NAS, cloud queue.
  Compatibility dashboard and site-health backend. Automated site test farm. AI-assisted detection or
  adapter generation.
- Popup paint instrumentation. Firefox verification (D19: experimental until it can be run).

## 9. Technical architecture

TypeScript (strict, `noUncheckedIndexedAccess`, ESM), Svelte 5 with runes, Vite 7, Manifest V3, zero
runtime dependencies. Five Rollup passes per target produce the HTML pages plus three IIFE bundles
(background, content script, page hook) — a content script cannot be a module, and Rollup emits at most
one IIFE per build.

Full module map, data flow diagram and twenty-one numbered decisions with trade-offs:
[ARCHITECTURE.md](ARCHITECTURE.md).

## 10. Folder structure

```
media-grab/
  scripts/            build.mjs, manifest.mjs, icons.mjs
  src/
    core/             types, download-types, errors, messages, hook-protocol, limits,
                      redact, log, fetch
    browser/          api (interface), webext (the only chrome.* call site), index
    detection/        dom, candidate, network, manifest-loader, manifest-cache, saveability, engine, diagnose
    inject/           page-hook.ts (MAIN-world content script), routes.ts (what counts as a new route)
    manifests/        segment-plan, url, drm-systems, hls/{attributes,parse,segments},
                      dash/{xml,duration,model,segment-info,parse,segments}
    media/            format, fingerprint, dedupe, score, quality, saveability, naming, poster
    downloads/        manager, task-factory, engines, referer-rules, interrupt-reasons, retry, browser-progress,
                      state-machine, progress, plan-builder, segment-fetcher, assembler, assembly-host
    adapters/         types, registry, sites/generic
    offscreen/        index, protocol
    permissions/      site-access, content-scripts
    storage/          settings, history
    background/       index, services, message-router, tab-store, scanner,
                      download-hooks, queue-store, offscreen-lifetime, badge, context-menus
    content/          index
    ui/               popup/, options/, components/, lib/, styles/, harness/, *.html
  tests/
    unit/             hls, dash, media, media-rules, redact-fetch, downloads, core, manager,
                      background, engines, detection, durability, referer-rules, caps, assembly,
                      navigation, best, saveability, integration, storage-*, ui-*
    e2e/              popup.spec.ts (the UI harness)
    extension/        extension, durability, choice, navigation, shipping-build specs; fixture-site
  design/             IDENTITY.md
  dist/{chrome,firefox}   build output (gitignored)
```

## 11. Data model

`MediaCandidate` is the spine: a stable fingerprint id, the URL and page context, `kind` ·
`protocol` · `format` · `source`, optional `resolution` · `bitrate` · `fps` · `duration` · `sizeBytes`
(with `sizeEstimated`) · `codecs` · `language`, `tracks: {video, audio}`, optional `variants[]` ·
`audioTracks[]` · `subtitles[]`, `score` with `scoreReasons[]`, `live` / `drm` / `drmSystem`, and
`saveability` — whether it can be saved, and why not (D21).

`MediaVariant` is one rung of a ladder, carrying bandwidth, resolution, fps, codecs, track flags, the
HLS `audioGroupId` and the DASH representation/adaptation-set ids needed to rebuild its segment URLs,
its own `saveability` where it differs from the candidate's, an audio track's `role` and `default`
(D20), and `segmentCount` where the manifest says.

`ScanResult` is what the popup renders: candidates, rejected candidates with reasons, `ScanStats`, and an
optional `Diagnosis`.

`DownloadTaskView` is the serializable download record: state, strategy, whether Pause keeps the work
done (`pausable`), progress (received, total and whether it is an estimate, speed, ETA, segment counts),
attempts, classified error (with `accessHost` when a grant would help, D18), browser download id, and
`canRetry: false` for a task recovered without its address (D16).

A content script does not send candidates: it sends `ReportedCandidate` claims (URL, kind, where it was
found, what the page says about it), which the worker allow-lists and rebuilds.

Storage: `storage.local` holds `settings` and `history` (file name, site, time — no URLs);
`storage.session` holds `scan:<tabId>`, `ctx:<tabId>` and `downloads:queue` (the queue, with URLs);
`storage.local` also holds `downloads:trace` (unfinished tasks, no URLs) (D16). Nothing is synced.

## 12. API architecture

There is no HTTP API. The internal contract is the message protocol in `src/core/messages.ts` — nine
message types, every inbound one validated by `parseMessage` before it is acted on, with string length
caps and array size caps because a content script's output is untrusted input. The worker also checks
the sender: a content script may only send `PAGE_REPORT`; everything else must come from the
extension's own pages.

Outbound HTTP is only ever: manifest fetches and segment fetches, always `credentials: 'omit'`. Scripts
set no header except `Range`; during a download the page is named as `Referer` by a session
`declarativeNetRequest` rule, to granted hosts only (D18). Direct files are fetched by the browser's own
download manager.

## 13. Cloudflare architecture (future)

Nothing about the extension requires a backend, and § 2 goal 4 says none will handle user data. If a
backend is ever built it is for three things that never touch a page URL:

- **Adapter registry** — Workers + R2 serving signed adapter bundles, with a public verification key
  pinned in the extension. Blocked on the key-management and review process in `ARCHITECTURE.md` D7.
- **Site health** — D1 holding per-site pass/fail from an automated test farm, rendered as a public
  compatibility dashboard.
- **Anonymous diagnostics** — only if it can be built with no URL, no page title and no identifier, and
  only opt-in. Today the honest version is the clipboard export.

## 14. Deployment architecture

`pnpm build` produces `dist/chrome` and `dist/firefox`, loaded unpacked (README).
Store distribution is not set up. When it is, the checklist is: a real extension id and signing key, a
store listing that states the DRM position explicitly, screenshots of the permission flow, and a privacy
policy that can truthfully say "no data collected".

## 15. Security model

Full treatment in [SECURITY.md](SECURITY.md): threat model, the page-hook / content-script / worker trust
boundaries, filename sanitization as a security boundary, observe-only network access, credential
omission, parser hardening (DTD rejection, bounds, quote-aware tokenizers), the privacy position, and
six stated weaknesses.

## 16. Performance targets

Budgets and measurements in [PERFORMANCE.md](PERFORMANCE.md). Headline (0.1.6): popup 30.2 KB JS gzip
against a 60 KB budget; background 37.7 KB against 40 KB; content script 7.9 KB against 15 KB; page
hook 2.7 KB against 3 KB. Popup paint time and DOM-scan cost are explicitly **not yet instrumented**.

## 17. Accessibility requirements

WCAG 2.2 AA, gated in CI-shaped tests rather than reviewed by eye.

- Every text token clears 4.5:1 against its ground in both light and dark. `@axe-core/playwright` runs
  over the popup and options in both schemes and zero serious/critical violations is a gate.
- Semantic structure: `<article>` per row, real `<h2>`/`<h3>`, `role="meter"` with `aria-valuenow` on the
  signal meter, `role="progressbar"` with a live `aria-valuenow` on downloads, `aria-expanded` on the
  ladder disclosure, `role="status"` on notices.
- Keyboard: everything reachable, a visible 2 px focus ring on `:focus-visible`, tested.
- `prefers-reduced-motion` collapses both transitions to 0 ms.
- Not yet done: a screen-reader pass with VoiceOver, and localisation of the mono micro-labels for
  languages where uppercase letterspacing reads badly.

## 18. SEO requirements

Not applicable — a `chrome-extension://` popup has no SEO surface. The equivalent concern is store
listing quality and the compatibility dashboard (§ 13), neither of which exists yet.

## 19. Testing strategy

[TESTING.md](TESTING.md). Three layers: 560 unit tests, 27 Playwright tests over the UI against
a fixture harness (axe in both colour schemes), and 45 tests that load the real built extension into
a real Chromium against a local fixture site, including worker death and a simulated update. The third layer was added in 0.1.1 and
immediately found three bugs, one of which broke every HLS and DASH download on Chrome. The remaining
gap is Firefox, which Playwright cannot drive.

## 20. Monitoring strategy

There is no telemetry and there will be none by default, so "monitoring" means what a user can see
locally:

- Power mode footer: requests observed, manifests parsed, candidates filtered.
- Debug logging, off by default, which is the only mode that writes full URLs.
- The clipboard diagnostics export, fully redacted.

Fleet-level health would come from the automated site test farm (§ 25), not from users' browsers.

## 21. Error handling

Sixteen classified codes (`src/core/errors.ts`) with user-facing copy held next to them so the popup and
the notification path cannot diverge: `MEDIA_NOT_FOUND`, `STREAM_EXPIRED`, `AUTH_REQUIRED`,
`DRM_PROTECTED`, `NETWORK_ERROR`, `SERVER_REJECTED`, `UNSUPPORTED_MANIFEST`, `AUDIO_VIDEO_MISMATCH`,
`SEGMENT_FAILED`, `INVALID_MEDIA`, `BROWSER_PERMISSION`, `SITE_ADAPTER_ERROR`, plus `DISK_ERROR`,
`CANCELLED`, `INTERRUPTED` (a download a worker restart, update or browser restart cut off, D16) and
`INTERNAL`.

Codes are partitioned into retryable and terminal, which is what the queue uses to decide whether to try
again. HTTP statuses map onto codes. An `AbortError` is classified as a cancellation, not a failure.
Side-effect failures (adapter, notification, webhook-like paths) are caught and logged, never allowed to
break a download.

## 22. Backup / recovery

No user data worth backing up: settings and history are local conveniences, and MediaGrab never holds
the only copy of anything. History can be cleared from the options page. Downloads land in the browser's
own download folder and are the browser's from that point.

The download queue is saved (D16, `background/queue-store.ts`): in session storage for worker
restarts, and as a URL-free trace in local storage across updates and browser restarts. What remains
lost: an in-flight segmented download restarts from zero (§ 24).

## 23. Known limitations

The full list with reasons is in [README.md](README.md) § Known limitations: no muxing, no decryption,
in-memory assembly capped at 1.5 GB with no mid-flight pause, live and multi-Period DASH marked not
saveable, no bundled site adapters, Firefox experimental and never run, UI strings not translated,
subtitles and thumbnails detected but not downloaded, the page as Referer only to granted hosts (D18),
and after an update or restart only browser-held downloads followed again (D16).

## 24. Technical debt

1. **In-flight segmented downloads do not resume** across a worker restart: they are listed as
   interrupted, with Retry, and start again from zero (D16 option (d) — parts on disk — not taken).
   After an update or browser restart, only browser-held files are picked up again.
2. **Firefox still declares `webRequest` statically**, so it will carry the same install warning Chrome
   had until someone can actually run that build. Firefox is experimental (D19).
3. **The background bundle and the page hook are close to their budgets** (PERFORMANCE.md): the next
   feature in either should remove something first.
4. **The saved queue has no byte budget**, and rows recovered without their address stay until the user
   removes them (CONTEXT-RUNWAY.md § 12 lists the smaller residuals).
5. **Scoring weights are judgement.** Tests assert relations, not values, which is right, but the weights
   have never been checked against a corpus of real pages.
6. **`assembly-host.ts` branches on feature detection inside a function that also does message plumbing.**
   It wants splitting once a third assembly path exists.
7. **The offscreen document shares the runtime message bus**, separated by a `target` field — discipline,
   not isolation.
8. **i18n covers the manifest only.** `_locales/en/messages.json` exists and the manifest reads from it;
   every UI string is still inline English.
9. **Firefox has never been run**, only built — experimental, not a release gate (D19).
10. **One Referer rule per host** carries the most recent page's URL, so two tabs downloading from one
   CDN at once share it (D18).
11. **The permission-grant path, prerender, a literal extension reload and assembly memory** are
    release-checklist items (TESTING.md § 5), not automated tests.

## 25. Future roadmap

**v0.2 — make it real.** Subtitle and thumbnail download. Batch selection. Firefox verified (needs
`web-ext`, since Playwright cannot load Firefox extensions). Segmented downloads that resume after a
worker restart (parts on disk, D16 option (d)). (Shipped in 0.1.6: the persisted queue, D16; the
Referer rule, D18.)

**v0.3 — breadth.** Site adapter pack for the sites that need one. Playlist detection. Multi-period DASH.
Download rules. i18n with a real `_locales/`.

**v0.4 — the hard parts.** Muxing separate audio and video, via ffmpeg.wasm in the offscreen document, or
a native host if wasm start-up proves unacceptable. Streaming to disk, which the same decision unblocks.

**Later, if ever.** Signed remote adapters with a real key story. An automated site test farm and a
public compatibility dashboard. Live capture. The v3 ideas from the brief (phone transfer, NAS, cloud
queue, AI-assisted adapter generation) are not planned; none of them is worth anything until detection
coverage is measured rather than asserted.

## 26. Architectural decisions

Twenty-one, with full Context / Options / Choice / Why / Trade-offs in
[ARCHITECTURE.md](ARCHITECTURE.md) § 3:

D1 Svelte 5 rather than React · D2 hand-written browser abstraction rather than a polyfill ·
D3 hand-written XML reader for DASH · D4 offscreen-document assembly on Chrome, in place on Firefox ·
D5 in-memory assembly with a stated 1.5 GB ceiling · D6 optional per-origin host permissions ·
D7 bundled adapters only, no remote delivery · D8 score and explain rather than filter ·
D9 rebuild segment plans at download time · D10 a test build for the real-browser suite ·
D11 one report per frame · D12 download engines behind one interface · D13 see the page from inside ·
D14 pages send claims, the worker builds candidates · D15 the segment plan decides the container ·
D16 durability · D17 single-page-app players · D18 the page as Referer, never cookies ·
D19 Chromium is the target · D20 "best" = sound, then resolution · D21 saveability before the click.

## 27. Audit history

**2026-09-25 — the runway (0.1.6).** The six open owner decisions (P0-1…P0-5, P1-6) made under delegation (D16–D21)
and executed by four engineers on disjoint files; independent re-audit and verification round. Found
during integration: two segmented downloads starting together could send work to the offscreen
document before it listened (latent since the document existed). Report:
`reports/2026-09-25-runway-0.1.6.md`.

**2026-09-25 — code-and-flow audit, SOLID restructuring, re-audit (0.1.4).** Full report:
`reports/2026-09-25-solid-audit.md`. Three of the bugs below were reproduced
against 0.1.3 in Chromium with new extension tests before being fixed.

| # | Finding | Severity |
|---|---|---|
| 1 | "Best download" (button, shortcut, menu) took the first rendition listed, not the best. | High |
| 2 | An iframe's report was treated as a navigation of the whole tab. Reproduced. | High |
| 3 | DOM-only media was erased by a race between two messages from one scan. Reproduced. | High |
| 4 | Pausing a direct file never paused it; Resume downloaded it a second time. Reproduced. | High |
| 5 | A lone HLS media playlist could not be downloaded at all. | Medium |
| 6 | Pausing during the manifest fetch silently restarted the download. | Medium |
| 7 | "Scan again" did not wait for the page's fresh report. | Medium |
| 8 | Segmented downloads kept fetching after a segment had failed for good. | Low |
| 9 | Privileged messages were accepted from content scripts (defence in depth). | Low |
| 10 | `background/index.ts` and `downloads/manager.ts` each did five jobs; `chrome.*` was used outside `src/browser/`; two drifted manifest fetchers; eight dead settings. | Design |

**2026-09-09 — webRequest permission (reported from a real install).** Chrome warned: *"You need to
request host permissions in the manifest file in order to be notified about requests from the webRequest
API."* Reproduced against the shipping build: `addListener` does not throw, but with nothing granted the
listener never fires and a page load produced no scan at all — the warning was accurate, not cosmetic.

| # | Finding | Severity |
|---|---|---|
| 1 | `webRequest` declared statically with no host permissions: warned the user at install and could never fire. Now optional on Chrome, requested with the first site grant. | High |
| 2 | `NetworkObserver.start()` registered for `<all_urls>` at boot regardless of what was granted. Now takes the granted origin patterns and re-runs on every grant. | High |
| 3 | Observer registration ran *before* the message-handler registration and was unguarded, so a throw there would have left the popup talking to a worker that never answers. Now wrapped. | Medium |

Four tests were added against the shipping build — the configuration the test build cannot cover.

**2026-09-08 — first re-audit (self, in-session).** Re-ran the check suite, read for correctness gaps,
then built the missing layer: a suite that loads the real extension into a real Chromium against a local
fixture site.

Found and fixed, in severity order:

| # | Finding | Severity |
|---|---|---|
| 1 | `const doFetch = options.fetchImpl ?? fetch` detached `fetch` from its receiver. Tolerated in a service worker, fatal in the offscreen document — **every HLS and DASH download failed on Chrome** with `Illegal invocation`. Invisible to unit tests, which always inject a `fetchImpl`. | Critical |
| 2 | Direct downloads reported no byte progress: `downloads.onChanged` carries state, not bytes, so the bar sat at 0% until completion. | High |
| 3 | Segment failures were unclassified — "5 of 5 segments could not be downloaded" with no reason, the exact generic message this product exists to avoid. | High |
| 4 | `SECURITY.md` claimed `Referer` was replayed on segment requests. It is a forbidden header name and `fetch` drops it; nothing was ever sent. | Medium (doc drift) |
| 5 | `NetworkObserver.forgetTab` was never called: per-tab state and `scan:`/`ctx:` session keys leaked for the whole browser session. | Medium |
| 6 | `DownloadManager.prune()` was never called: completed tasks accumulated in memory forever. | Medium |
| 7 | `duplicateOfExisting` was written, unit-tested and never called — dead code, against CHARTER § 2. Now wired: a double click joins the running download. | Medium |
| 8 | The popup's Settings button used `window.open` instead of `runtime.openOptionsPage()`, so it stacked up tabs and ignored `options_ui`. | Low |
| 9 | `recordCompleted` took a parameter it discarded. | Low |

The workspace-wide audit harness run was still outstanding at that point: it expects
web-app checks (Lighthouse, broken links) that do not apply to an extension, so it needs a
project-specific profile first.

## 28. Performance history

| Date | Version | Popup JS (gz) | Background (gz) | Content (gz) | Note |
|---|---|---|---|---|---|
| 2026-09-07 | 0.1.0 | 26.4 KB | 25.8 KB | 6.0 KB | first measurement, all within budget |
| 2026-09-08 | 0.1.1 | 26.5 KB | 27.0 KB | 6.3 KB | +1.2 KB background: progress poller, tab cleanup, duplicate check |
| 2026-09-25 | 0.1.4 | 26.6 KB | 29.1 KB | 6.6 KB | +1.7 KB background: per-tab report ordering, scan coalescing, sender check, in-browser pause/resume |
| 2026-09-25 | 0.1.5 | 29.4 KB | 34.5 KB | 7.3 KB | +5.4 KB background: allow-list gate and candidate rebuild, manifest cache, DASH inheritance model, retry module; page hook 1.0 → 2.5 KB (shares `classifyMediaUrl`) |
| 2026-09-25 | 0.1.6 | 30.2 KB | 37.7 KB | 7.9 KB | the saved queue, Referer rules, offscreen lifetime, saveability; background and page hook now closest to budget |

## 29. Security audit history

| Date | Version | Finding | Resolution |
|---|---|---|---|
| 2026-09-07 | 0.1.0 | Filename sanitization left interior `..` after separator removal | Dot runs beginning a word are now removed; regression test asserts a hostile title cannot escape the folder |
| 2026-09-07 | 0.1.0 | Illegal-character regex held literal control bytes in source | Replaced with a code-point test; no control character appears in any source file |
| 2026-09-07 | 0.1.0 | No external security review has been performed | Outstanding |
| 2026-09-08 | 0.1.1 | SECURITY.md claimed a `Referer` replay that never happened (forbidden header, dropped by `fetch`) | Documented accurately; the no-op header removed from all three fetch sites; an extension test pins what actually reaches the server |
| 2026-09-08 | 0.1.1 | Per-tab detection state was never released, so session storage grew for the whole browser session | `tabs.onRemoved` now clears the observer and both session keys |
| 2026-09-09 | 0.1.2 | `webRequest` declared with no host permissions: a broader install prompt than the extension could honour, and a listener that could never fire | Moved to `optional_permissions` on Chrome and requested with the first site grant; the observer registers for granted origins only, never `<all_urls>` |
| 2026-09-25 | 0.1.4 | The worker accepted download, command and settings messages from content scripts, which run inside web pages | Sender rule in `message-router.ts`: content scripts may only send `PAGE_REPORT`; everything else must come from an extension page (checked by the browser-set sender URL) |
| 2026-09-25 | 0.1.4 | `network.ts`, `assembly-host.ts` and the offscreen document called `chrome.*` directly, outside the audited abstraction | All three go through `BrowserApi`; nothing outside `src/browser/` touches the namespace |
| 2026-09-25 | 0.1.5 | Content scripts sent finished candidates, checked on two fields: a page could pre-set variants (skipping manifest expansion), a score, or a `javascript:` URL | Reports carry allow-listed claims (http(s) only, each field bounded, a size budget per report); the worker builds every candidate itself |
| 2026-09-25 | 0.1.5 | `page-hook.js` was web-accessible on `<all_urls>`, so any site could detect that MediaGrab was installed | Registered as a MAIN-world content script; no web-accessible resources |
| 2026-09-25 | 0.1.5 | History stored page URLs unredacted; a failed row could show a signed segment URL | History stores no URLs; error details redact URLs; redaction now covers Akamai and JWT path tokens, nested URLs and short signature parameters |
| 2026-09-25 | 0.1.6 | Referer policy decided (D18): the page as Referer via a session `declarativeNetRequest` rule, scoped to MediaGrab's own requests (no tab), the task's hosts and granted hosts only; cookies never | Permission `declarativeNetRequestWithHostAccess` (no install warning); an extension test pins what reaches the server |
| 2026-09-25 | 0.1.6 | Durability without keeping tokens: the queue in session storage only; across updates and restarts a URL-free trace | Test asserts the trace holds no URL |

## 30. Major changes

| Date | Change |
|---|---|
| 2026-09-07 | Project created. Detection engine, HLS/DASH parsers, intelligence layer, download engine, popup and options page built; 124 unit + 10 UI tests; Chrome and Firefox builds produced. Departed from the brief on the UI framework (Svelte over React) and on remote adapters (not implemented). |
| 2026-09-08 | First re-audit. Added a real-browser extension test suite (12 tests) and the `chrome-test` build it needs; it found a critical bug that broke every segmented download on Chrome, plus eight smaller ones (§ 27). Detection and all three download paths now verified end to end. |
| 2026-09-09 | Permission model corrected after a real install warning: `webRequest` is optional on Chrome and granted with the first site, and the network observer is scoped to granted origins. Four tests added against the shipping build. |
| 2026-09-25 | 0.1.4: code-and-flow audit and SOLID restructuring. The worker's god file split into composition root, tab store, scanner, message router, services and download hooks; the download manager's fetching moved behind a `DownloadEngine` interface. One `PAGE_REPORT` per frame replaces two racing messages. Nine flow bugs fixed, three of them reproduced in Chromium first; an independent re-audit found seven more (three medium), all fixed, and a verification pass four more. 177 unit + 34 Playwright tests. |
| 2026-09-25 | 0.1.5: second audit of every layer (68 bugs, 38 design items), fixed and restructured (page hook as a MAIN-world content script, Resource Timing, route-start navigation, allow-listed page claims, one media-URL rule, DASH parser rebuilt, containers settled by the playlist, popup controller); independent re-audit found 29 more, two of them High regressions from the fixes, all fixed; a verification round found six more (two Medium), fixed. Ten real-browser fixtures fail on 0.1.4 and pass on 0.1.5. 380 unit + 52 Playwright tests. Report: `reports/2026-09-25-solid-audit-2.md`. |
| 2026-09-25 | 0.1.6: the runway — durability (D16), single-page-app targets (D17), Referer where allowed (D18), Chromium as the target (D19), a written "best" (D20), saveability before the click (D21). 560 unit + 72 Playwright tests; worker death and updates are automated release gates. |
