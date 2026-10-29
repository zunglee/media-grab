# MediaGrab — Context Runway Book

**What this is.** One document that gives an engineer or an agent everything needed to pick MediaGrab
up and move it forward without re-deriving the past: what the product is, how it is built, how each
flow runs, what was decided and why, what is known to be wrong, which questions are still the
owner's, and what comes next.

**What it deliberately leaves out.** Values and parameters. No caps, thresholds, timeouts, sizes, test
counts, bundle sizes, ports, hostnames or credentials appear here — those change, and a copy in a
context document goes stale silently. Every such value is named and pointed to where it lives (§ 9).
Versions and dates are kept, because they are history anchors, not parameters.

**State described.** MediaGrab as of version 0.1.6 (2026-09-25). When the code moves, update the
sections that changed and the "Last reconciled" line at the bottom.

---

## Contents

1. What MediaGrab is
2. Constraints that shape everything
3. Where things are (repository, tooling, documents)
4. Architecture: layers and modules
5. The flows, end to end
6. State, lifetimes and durability
7. Trust and security model
8. Decision index
9. Named limits — where every value lives
10. How the work is verified
11. History
12. Known gaps
13. External review received — mapped to current state
14. Owner decisions — answered under delegation
15. The runway — what to do next, and what not to do
16. Working agreements
17. Lessons and traps
18. Glossary

---

## 1. What MediaGrab is

A browser extension (Manifest V3) that finds the media on the page in front of the user — direct
files, HLS and DASH streams — ranks it, explains what it cannot take, and downloads what it can. One
source builds a Chrome/Chromium-family package and a Firefox package.

**Promises the product makes** (source: `extensive.md` §§ 1–3):

- The primary action is "the best version" — one click, no codec knowledge needed.
- It says *why* when something cannot be downloaded (DRM, JavaScript-assembled media, not started yet,
  embedded elsewhere) instead of "no media found".
- It never bypasses DRM, never decrypts, never borrows the user's credentials for a background fetch.
- Nothing leaves the machine: no backend, no telemetry, no analytics. Diagnostics go to the clipboard
  for the user to read before sharing.
- It asks for one site at a time, not "all your data on all websites".

**Non-goals** (explicit): circumventing protection, recording live streams, a site-by-site hard-coded
downloader, cloud features.

**Status label in the README:** pre-alpha. Chromium is verified in a real browser; Firefox is built but
has never been run.

---

## 2. Constraints that shape everything

These are facts of the platform or of the owner's rules. Most design decisions follow from one of them.

| Constraint | Consequence in the code |
|---|---|
| An MV3 background is a **service worker** on Chrome: stopped when idle, killed on update, no DOM. | Nothing long-lived may sit only in worker memory; per-tab detection state is in `storage.session`; no `createObjectURL` in the worker, so assembly runs in an **offscreen document** (Chrome) or in place (Firefox event page). |
| Firefox's background is an **event page** with a DOM, and differs on pause semantics, permissions and APIs. | Everything browser-specific goes through one interface, `src/browser/` (D2). Firefox-specific behaviour is implemented from documentation, unverified in a real browser. |
| **Host permissions are optional and per origin** (D6). `webRequest` does nothing without them. | Detection cannot rely on the network observer alone; the page hook and Resource Timing see from inside the page (D13). The first grant on a site needs a reload for full network visibility. |
| **`fetch` drops forbidden headers** (`Referer`, `Origin`). | Scripts send only byte ranges; the page is named as Referer by a session `declarativeNetRequest` rule, to granted hosts only (D18). A CDN that gates on Referer and holds no grant answers 403. |
| **The page is hostile input.** Content scripts run inside it. | Every message is shape-checked; pages send *claims*, the worker builds candidates (D14); sender rules decide who may send what. |
| **An extension cannot stream to disk.** | Segmented downloads assemble in memory, under a stated ceiling, and cannot be paused mid-flight (D5). |
| **No muxer ships.** | A split stream downloads as two files, video and audio (D20); a lone video-only rendition is labelled "no sound". |
| **Zero runtime dependencies**, one toolchain across the monorepo, strict TypeScript, ESM only. | Hand-written DASH XML reader (D3), hand-written browser abstraction (D2), Svelte 5 for UI (D1). |
| **The repository has no git commits.** | There is no diff history and no git undo. Every change pass snapshots the source first, outside the repo. Committing is the owner's call. |

---

## 3. Where things are

### 3.1 Repository

- This repository is MediaGrab on its own. It was developed as one package of a private pnpm
  workspace, whose engineering charter (`CHARTER`: no gamed metrics, required docs, audit rules),
  design rules (`DESIGN-OS`) and audit tool are referred to by name in the decisions and reports; they
  are not part of this repository.
- Audit reports — the tool's and the written ones — are in `reports/`.

### 3.2 Commands (package scripts — see `package.json` for the exact list)

| Script | What it does |
|---|---|
| `build` | Builds `dist/chrome` and `dist/firefox` from one source; the manifest is generated by `scripts/manifest.mjs`. |
| `test` | Vitest unit tests (Node, no browser). |
| `test:e2e` | Rebuilds the test build (`dist/chrome-test`), then Playwright: the UI harness suite and the real-extension suite. |
| `typecheck` / `lint` | svelte-check + tsc; Biome. |
| `dev` | The UI harness (popup and options against an in-memory fake browser). |
| `audit` | The repo's audit framework for this package. |

Dead-code check: knip, configured by `media-grab/knip.json` (the extension's real entry points).

### 3.3 Documents — which one answers what

| Question | Document |
|---|---|
| What is it for, and what is the honest per-feature status? | `extensive.md` (living spec; § 8 is the ledger) |
| How is it built, and why this way? | `ARCHITECTURE.md` (module map, flows, decisions D1–D21, DRM line, muxing, download states and commands) |
| What can a hostile page or server do? | `SECURITY.md` |
| What are the budgets? | `PERFORMANCE.md` |
| What is tested, what is not, and why? | `TESTING.md` |
| What changed, version by version? | `CHANGELOG.md` |
| What was found and fixed in each audit? | `reports/2026-09-25-solid-audit.md` (0.1.4), `…-solid-audit-2.md` (0.1.5), `…-runway-0.1.6.md` (0.1.6) |
| Everything above, as context for the next step | this book |

---

## 4. Architecture: layers and modules

### 4.1 The dependency rule

`core` depends on nothing. `manifests` and `media` depend only on `core`. `detection` and `downloads`
may use `browser`. `background` composes everything. `ui` may use everything but is the only layer that
renders. Only `src/browser/` touches `chrome.*` / `browser.*`.

### 4.2 Modules by responsibility

| Area | Modules | Job |
|---|---|---|
| Contracts | `core/types`, `core/download-types`, `core/messages`, `core/hook-protocol`, `core/errors`, `core/limits` | Shapes, the message protocol and its validation, error codes and their user copy, every cap on page input. |
| Platform | `browser/api`, `browser/webext`, `browser/index` | The one interface to the browser, and its only implementation. |
| In the page | `inject/page-hook` (MAIN world), `inject/routes`, `content/index` (ISOLATED world), `detection/dom` | Watch fetch/XHR/MediaSource/EME and route changes (History API, hash, Navigation API) from inside the page; scan the DOM; read Resource Timing; send one report per frame. |
| Detection in the worker | `detection/network`, `detection/candidate`, `detection/engine`, `detection/manifest-loader`, `detection/manifest-cache`, `detection/saveability`, `detection/diagnose` | Observe responses; build candidates from claims and observations; the scan pipeline; expand manifests; decide saveability (D21); explain empty results. |
| Stream formats | `manifests/hls/*`, `manifests/dash/*`, `manifests/segment-plan`, `manifests/url`, `manifests/drm-systems` | Parse playlists and MPDs into one segment-plan shape; resolve URLs; name DRM systems. |
| Media rules | `media/format`, `media/fingerprint`, `media/dedupe`, `media/score`, `media/quality`, `media/saveability`, `media/naming`, `media/poster` | What a URL is; identity; de-duplication; ranking; ladders and "best" (D20); what can be saved; filenames; row previews. |
| Downloads | `downloads/manager`, `task-factory`, `engines`, `referer-rules`, `plan-builder`, `segment-fetcher`, `assembler`, `assembly-host`, `browser-progress`, `retry`, `interrupt-reasons`, `state-machine`, `progress` | The queue and its states; how bytes arrive; the page as Referer (D18); plans rebuilt at download time; segment fetching and assembly; progress; retries; the browser's interrupt reasons. |
| Composition | `background/index` (wiring only), `services`, `message-router`, `tab-store`, `scanner`, `download-hooks`, `queue-store`, `offscreen-lifetime`, `badge`, `context-menus` | Build collaborators once; route messages with sender rules; per-tab state under a byte budget; one scan per tab in flight; side effects of downloads; save and restore the queue (D16); close the offscreen document when idle. |
| Access | `permissions/site-access`, `permissions/content-scripts` | Per-origin grants; register the page hook and content script for granted origins. |
| Storage | `storage/settings`, `storage/history` | Settings with defaults, clamping and unknown-key rejection; history without URLs. |
| Chrome only | `offscreen/index`, `offscreen/protocol` | Assembly document and its messages. |
| UI | `ui/lib/popup-controller`, `bridge`, `media-view`, `download-view`, `diagnostics`; `ui/components/*`; `ui/popup`, `ui/options`; `ui/harness/*` | Popup logic in plain TypeScript (unit-tested); components only render; a harness with a fake browser. |
| Extension points | `adapters/types`, `adapters/registry`, `adapters/sites/generic` | Site adapters may add and re-rank, never remove. Only the generic adapter ships. |

---

## 5. The flows, end to end

Each flow names its modules in order. The rules that make it correct are stated with it.

### 5.1 A page is detected

1. **Registration.** On a granted origin, `permissions/content-scripts` has registered `page-hook.js`
   (MAIN world) and `content.js` (ISOLATED world) at document start, in all frames. No web-accessible
   resources exist, so a site cannot probe for the extension.
2. **Inside the page.** The hook wraps fetch, XHR, MediaSource, EME and object-URL creation with one
   rule (`wrapMethod`), reports media-looking URLs, MSE/EME signals and route changes over the shared
   `hook-protocol`. The content script asks the hook to replay (`hello`), because their start order is
   not promised. A prerendered document stays silent until it is shown.
3. **The report.** The content script builds one `PAGE_REPORT` per frame: page URL and title,
   `routeStartedAt`, signals, element counts, and **claims** (URLs with what the page says about them),
   including Resource Timing entries. A report is always that frame's complete state, never a delta.
4. **The worker.** `message-router` checks shape and sender (content scripts may send only
   `PAGE_REPORT`), then `tab-store` folds the report into the tab: only the top frame names the page;
   a new `routeStartedAt` from the top frame is a navigation; a frame's report replaces its own earlier
   claims. Updates for one tab apply one at a time.
5. **The network side.** `detection/network` observes responses for granted origins, drops segments,
   keeps prerendered pages' traffic aside until that page is shown, and cuts its per-tab state at the
   route's start so a manifest fetched before the report survives.
6. **The scan.** `scanner` runs at most one scan per tab, with one shared follow-up; a caller whose
   data a running scan already includes joins it. `detection/engine`: collect → dedupe → normalize →
   expand manifests (cached briefly by `manifest-cache`) → probe each master's best rendition and
   decide saveability (D21) → fold a master's nested playlists (audio playlists stay as audio rows) →
   rank → diagnose. The result is stored per tab, the badge updated,
   and `SCAN_RESULT` broadcast to open popups.

### 5.2 "Scan again"

Popup → `REQUEST_SCAN` → the worker injects the content script if the grant is new → sends the request
to every frame and waits for the top frame's answer (both messages carry one random request id, so a
frame answers once) → scans, joining a scan that already includes the fresh report.

### 5.3 "Best download"

One rule (D20), `media/quality.ts` `pickBestDownload`, used by the popup button, the keyboard shortcut
and the context menu: among saveable renditions, one with sound beats one without; then the higher
resolution; then the higher bitrate; then the candidate's score. A video-only winner of a split stream
comes with its best audio track, and both are queued as two files. The shortcut and menu first make sure
the stored scan is of the page on screen.

### 5.4 A download

`START_DOWNLOAD` (from an extension page only) → `manager.enqueue` refuses what the scan marked
unsaveable (D21), resolves the rendition
(`task-factory.renditionToFetch`: the user's pick, else best, else a lone media playlist as its own
rendition), joins an identical rendition already running, creates the task → `pump` fills free slots
→ the engine for the strategy runs:

- **Direct file** (`browserEngine`): the browser fetches and writes; it keeps the partial file, so
  pause and resume are delegated to it; progress is polled from its record.
Before fetching, each engine names the URLs it will use, and the manager holds a Referer rule for those
hosts until the task settles (D18, `referer-rules`).

- **Segmented** (`segmentedEngine`): rebuild the plan from the manifest now (D9) → the plan settles the
  container and the filename is corrected (D15) → fetch segments with bounded adaptive concurrency,
  shared retry rules, and a stop at the first segment that fails for good → assemble in memory (offscreen
  on Chrome) → check the user has not stopped it → hand the blob to the browser.

Completion and failure arrive later from `downloads.onChanged`; `interrupt-reasons` maps the browser's
reasons (a Firefox pause arrives as an interruption and is recognised as a pause). A 403 from a host
MediaGrab has no grant for fails with an "Allow ‹host› and retry" offer (a 401 needs the user's
session, which no grant gives).

The queue is saved on every structural change (`queue-store`, D16) and read back by the next worker.

### 5.5 Pause, resume, cancel

The state machine (`downloads/state-machine`, table in `core/download-types`) is the only writer of a
task's state. A task is `pausable` only when its engine can pause without losing work (direct files);
segmented downloads offer Cancel only. Any error from an attempt the user stopped is treated as the stop
it was. A file handed to the browser after the user stopped the task is taken back.

### 5.6 After a download completes

`download-hooks`: `DOWNLOADS_STATE` broadcast; history entry (no URLs stored) and a notification, each
only if settings allow. Completion is reported once per task.

### 5.7 Granting a site

Popup → `permissions.request` for that origin (Firefox: without a permission it declares as required) →
the worker re-registers content scripts only if the set changed, restarts the network observer on the
granted origins, and "Scan again" injects into the open tab.

---

## 6. State, lifetimes and durability

### 6.1 Where state lives

| State | Lives in | Gone when |
|---|---|---|
| Last scan per tab | `storage.session` (under the per-tab byte budget) | replaced by the next scan, tab closed, browser session ends |
| Page context per tab (all frames) | `storage.session` (same budget) | top frame starts a new route, tab closed, session ends |
| Network observations per tab | worker memory | worker stops, route starts, tab closed |
| Manifest details cache | worker memory | its time-to-live, worker stops |
| Download queue with its candidates | `storage.session` (`downloads:queue`) | task removed, extension update or reload, browser restart |
| Trace of unfinished tasks (no URLs) | `storage.local` (`downloads:trace`) | task finished or removed |
| Referer rules | the browser's session rules | last task using the host settles; the next worker clears leftovers at start, before restoring the queue |
| Offscreen document | the browser | no segmented task is fetching or verifying |
| Settings, history | `storage.local` | the user clears them |

### 6.2 Durability contract (D16) — what survives what

Legend: **S** survives · **T** dropped with a visible trace: an interrupted row, with Retry only where
the task's candidate survived (worker restarts), without it after an update or restart · **B** the
browser keeps the file and MediaGrab follows it by its download id.
Rows marked **auto** have an automated real-browser test (`tests/extension/durability.spec.ts`);
the others are unit-tested (`tests/unit/durability.test.ts`) and on the release checklist.

| Task state | Worker stopped (idle or killed) | Extension update / reload | Browser restart |
|---|---|---|---|
| Queued (any engine) | S | T (scan the page again) | T (scan the page again) |
| Direct file, browser fetching | B — reaches history even if no worker runs when it completes (**auto**) | B | B (the browser's own list decides) |
| Direct file, paused in the browser | S (**auto**) | B, paused, resumable (**auto**, update simulated) | B |
| Segmented, planning or fetching | T (Retry; starts again from zero) | T (scan the page again) | T (scan the page again) |
| Segmented, handed to the browser | B | B | B |
| Failed, completed, cancelled | S | gone from the list (history keeps completed files, if enabled) | same |
| Scan results, page context | S | lost (pages reload anyway) | lost |
| Network observations | lost — mitigated: the page hook and Resource Timing re-report | lost | lost |
| Settings, history | S | S | S |

After an update or restart the saved queue (with its URLs) is gone by design: only the trace remains,
so a row can be shown and a browser download followed, but not retried without the page.
The offscreen document is closed as soon as no segmented download needs it, which also releases any
orphaned blob.

---

## 7. Trust and security model

Full treatment: `SECURITY.md`. The shape of it:

- **Trust boundaries.** Page (hostile) → page hook (MAIN world, posts only a namespaced envelope) →
  content script (validates source and origin, rebuilds everything) → worker (allow-lists every field
  of every claim; http(s) only; caps from `core/limits`). Pages send claims; only the worker builds
  candidates (D14).
- **Sender rules.** Content scripts may send only `PAGE_REPORT`; starting, commanding or reconfiguring
  downloads is accepted only from the extension's own pages, identified by the browser-set sender URL.
- **Network identity (D18).** Every background fetch omits credentials. The page is named as Referer
  through a session `declarativeNetRequest` rule scoped to MediaGrab's own requests (no tab), the task's
  hosts, the task's lifetime, and hosts MediaGrab may access. A resource that needs the user's session
  fails as `AUTH_REQUIRED`; a host that refuses and holds no grant is offered: "Allow ‹host› and retry".
- **Filenames** are the highest-consequence output: sanitized against traversal, reserved names and
  control characters; long titles are cut without losing the extension or splitting a character.
- **Parsers** refuse rather than guess: the DASH reader refuses DTD/ENTITY; oversized manifests and
  over-long plans are refused, never truncated.
- **Redaction** for logs, error details and the diagnostics export: token-like parameters, signature-like
  path segments, nested URLs, credentials.
- **Privacy.** History keeps no URLs. No telemetry exists — not off, absent.
- **Known weaknesses** are listed in `SECURITY.md` § 9; the one-line summary is in § 12 here.

---

## 8. Decision index

Full records (Context · Options · Choice · Why · Trade-offs) are in `ARCHITECTURE.md` § 3.

| # | Decision | One line |
|---|---|---|
| D1 | Svelte 5, not React | Compiles away; one toolchain across the monorepo. |
| D2 | Hand-written browser abstraction | Real Chrome/Firefox differences need a layer anyway; enables the fake browser. |
| D3 | Hand-written XML reader for DASH | No DOMParser in a service worker; general parsers are where XXE lives. |
| D4 | Offscreen assembly (Chrome) / in place (Firefox) | Bytes never cross a message boundary. |
| D5 | In-memory assembly with a stated ceiling | No disk streaming without a native host; fail clearly above the ceiling. |
| D6 | Optional host permissions per origin | The honest permission ask; first grant needs a reload. |
| D7 | Adapters bundled only | Remote code needs a signing and revocation story that does not exist. |
| D8 | Score, do not filter | Everything below the threshold stays inspectable with its reasons. |
| D9 | Rebuild segment plans at download time | A cached plan is wrong after a worker restart or for live manifests. |
| D10 | A test build rather than no integration test | Two manifest lines the browser's prompt cannot grant in a test. |
| D11 | One report per frame; only the top frame names the page | Full-state messages make loss and reordering harmless. |
| D12 | Download engines behind one interface | New ways to download are new engines; the manager is testable. |
| D13 | See the page from inside (MAIN-world hook, Resource Timing, route times) | Finds CDN-hosted manifests without asking for more hosts; navigation is a fact the page states. |
| D14 | Pages send claims; the worker builds candidates | The trust boundary enforced where data crosses it. |
| D15 | The segment plan decides the container | The file's extension comes from what the playlist says, not the protocol. |
| D16 | Durability contract (answers P0-1) | Queue in session storage; a URL-free trace across updates and restarts; browser downloads followed by id; offscreen closed when idle. |
| D17 | Single-page-app players are the target (P0-2) | History API, hash routes and the Navigation API all count as navigation; static pages are the easy case. |
| D18 | The page as Referer, never cookies (P0-3) | A session header rule to granted hosts only; "Allow ‹host› and retry" otherwise. |
| D19 | Chromium is the target; Firefox experimental (P0-4) | Firefox still builds; it is not a release gate until it can be run. |
| D20 | "Best" = sound, then resolution, then bitrate (P0-5) | A split stream's winner comes with its audio, as two files. |
| D21 | Saveability decided at scan time (P1-6) | Shown on the row, respected by "Best download" and refused by the manager. |

---

## 9. Named limits — where every value lives

Values are not copied here. Change them in one place, with the reason next to them.

| Kind of limit | Where |
|---|---|
| Per-tab session-storage byte budget (scan and context) | `src/core/limits.ts` |
| Every cap on page input (URL and title lengths, claims per frame and per tab, report size, hook memory, DOM scan bounds, JSON-LD bounds, manifests expanded per scan) | `src/core/limits.ts` — each with its reason |
| Network candidates held per tab; prerendered pages held per tab | `src/detection/network.ts` |
| Manifest size; manifest fetch timeouts | `src/core/fetch.ts`, `detection/manifest-loader.ts`, `downloads/plan-builder.ts` |
| Manifest cache lifetime and size | `src/detection/manifest-cache.ts` |
| Segments per plan (refused above it) | `src/manifests/segment-plan.ts` (`assertPlanSize`) |
| In-memory assembly ceiling | `src/core/limits.ts` (enforced in `src/downloads/segment-fetcher.ts`) |
| Segment concurrency bounds and growth; segment timeout | `src/downloads/segment-fetcher.ts` |
| Retry backoff | `src/downloads/retry.ts` |
| Progress smoothing; browser progress polling; progress broadcast rate; finished-task time in the list | `downloads/progress.ts`, `downloads/browser-progress.ts`, `downloads/manager.ts` |
| Display threshold and scoring weights | `src/media/score.ts` |
| User-adjustable limits (concurrency, retries, history size) and their clamps | `src/storage/settings.ts` |
| Bundle budgets | `PERFORMANCE.md` |
| Browser platform limits (session storage quota, worker idle timeout) | the browsers' documentation; not restated anywhere in the code |

---

## 10. How the work is verified

### 10.1 Layers

1. **Unit (Vitest, Node).** Everything above the scan result is pure and runs without a browser;
   the download manager runs through fake engines; the popup controller runs as plain TypeScript.
2. **UI (Playwright against the harness).** Real rendering and interaction with a fake browser; axe in
   both colour schemes as a gate.
3. **Extension (Playwright, real Chromium).** The shipping code loaded as `dist/chrome-test` (the
   shipping build plus host permissions for the fixture hosts and declarative content scripts), against
   a local fixture site; plus tests against the shipping build itself for the permission model.

### 10.2 Practices that caught real bugs — keep them

- **One detector per fixture.** Each fixture page lets exactly one detector find its media, so one path
  cannot hide another's failure. The original fixture hid a race because its video was also visible on
  the network. A second fixture host stands in for a CDN the build holds no grant for.
- **Prove the bug against the old build.** Before trusting a fix, run the *new* test against a snapshot
  of the untouched build; it must fail for the reason the bug predicts.
- **Mutation-check important fixes.** Revert the fix; the test must fail.
- **Independent re-audit, then a verification round.** Reviewers who wrote none of the code; then the
  same reviewers re-check their findings against the fixed tree. Fixes create new bugs — both passes
  found regressions introduced by their own fixes.
- **Assert through the extension's own state**, not the filesystem: Playwright intercepts extension
  downloads.

- **Stop the worker for real.** The DevTools protocol's `Target.closeTarget` on the worker's target,
  proved by a marker set in the old worker being absent from the next one.

### 10.3 What cannot be automated today — the release checklist (TESTING.md § 5)

- A literal extension reload (`chrome.runtime.reload()` leaves a command-line-loaded extension blocked;
  the test simulates it by clearing session storage and stopping the worker).
- Speculation Rules prerender, then activation (automated Chromium does not prerender).
- The permission-grant prompt itself, including "Allow ‹host› and retry".
- A late-injected content script on a page that has already routed.
- Assembly memory: one copy of the media held at hand-off.
- Anything on Firefox (experimental, not a gate).

---

## 11. History

| When | Version | What happened | Record |
|---|---|---|---|
| 2026-09-07 | 0.1.0 | Built: detection engine, HLS/DASH parsers, intelligence layer, download engine, popup, options, both builds. | CHANGELOG |
| 2026-09-08 | 0.1.1 | First re-audit; the real-browser suite is added and finds that every segmented download failed on Chrome (a detached `fetch`). | CHANGELOG, `extensive.md` § 27 |
| 2026-09-09 | 0.1.2–0.1.3 | Permission model corrected (optional `webRequest`, granted origins only); row previews with poster back-fill. | CHANGELOG |
| 2026-09-25 | 0.1.4 | Code-and-flow audit; SOLID split of the worker and the download manager; frame and sender rules; independent re-audit and verification. | `solid-audit.md` |
| 2026-09-25 | 0.1.5 | Second audit, every layer line by line; the page hook becomes a registered MAIN-world script with Resource Timing and route times; claims instead of candidates; DASH parser rebuilt; container decided by the plan; popup logic extracted; independent re-audit and verification. | `solid-audit-2.md` |
| 2026-09-25 | 0.1.6 | The runway: P0-1…P0-5 and P1-6 decided under delegation (D16–D21) and executed (W1–W9); worker death automated; an offscreen creation race found and fixed; independent re-audit and verification. | `runway-0.1.6.md` |

---

## 12. Known gaps

Consolidated; the authoritative lists are README "Known limitations", `extensive.md` §§ 8 and 24, and
the 0.1.6 report.

**Product**

- No muxing: a split stream downloads as two files (video, audio) (D20).
- No decryption: AES-128 HLS and DRM are marked unsaveable at scan time (D21).
- Segmented downloads assemble in memory under a ceiling, cannot be paused, and restart from zero after
  a worker restart (D16).
- Live streams and multi-Period DASH are listed and marked unsaveable.
- Subtitles and posters are shown, not downloadable. No site adapters ship. UI strings are English only.

**Detection**

- Players inside `about:blank`/`srcdoc` iframes or fetching from a Worker are invisible.
- Iframes inside a prerendered page are not tracked until it is shown.
- An HLS probe's saveability result is applied to the whole ladder; estimated sizes use the average
  bitrate. A stream whose every video rendition is too large is refused whole, its audio-only
  rendition included.

**Platform and durability**

- After an update or browser restart, queued and segmented tasks can be seen but not retried without
  the page (the URLs are not kept across sessions, by design).
- The per-tab byte budget has no cross-tab total, and the saved queue has no byte budget: failed rows
  keep their candidates until removed. A write that fails (storage full) is retried after a pause.
- Rows recovered without their address stay listed as interrupted until removed; while any is listed,
  the download manager starts at every worker wake.
- A failed or interrupted write between the two saved copies can bring a finished task back once:
  history de-duplicates by task id, but a second "Download complete" notification is possible.
- Firefox is experimental: built, never run (D19).
- The background bundle and the page hook have little headroom under their budgets.

**Network identity**

- MediaGrab adds no cookies: session-gated segmented media fails as `AUTH_REQUIRED`; a direct file
  carries the browser's own cookies, as any download does (D18).
- One Referer rule per host: two tabs downloading from one CDN at once share the latest page's URL.

---

## 13. External review received — mapped to current state

A written review of the 0.1.3 → 0.1.4 work was supplied by the owner on 2026-09-25. It judged that pass
a real engineering audit and advised against another SOLID pass; its gaps are below, with what 0.1.5
and 0.1.6 have since done about each.

| Review point | What it asked | Status after 0.1.6 |
|---|---|---|
| A. SPA / History API / iframe ordering is the hot path, not "low" | A named workstream and a non-static fixture (SPA + embedded player + `pushState`). | **Done (D17, W6).** Hash routes and the Navigation API are route changes, each with a single-detector fixture; anchors and placeholder links are not; a query-only `pushState` stays a new route by decision (D17); late injection starts its route at injection. **Open:** `about:blank`/`srcdoc`/Worker players. |
| B. Worker death is the architecture | A filled durability matrix with no "undefined" cells. | **Done (D16, W2).** § 6.2 is the contract, no undecided cells; worker death and a simulated update are automated tests. |
| C. Referer / credential removal may cost a High | An explicit network-identity policy and a supported "detected but cannot save" diagnosis. | **Done (D18, W5).** Referer from the page to granted hosts; never cookies; an extension test pins what reaches the server; "Allow ‹host› and retry" for the rest. |
| D. "Best" is under-specified | One written rule and tests against worst-first ladders, separate audio, and "4K video-only vs 1080p with sound". | **Done (D20, W4).** Written rule; tests for worst-first ladders, separate audio, 4K video-only vs 1080p with sound, progressive vs stream. |
| E. Detection vs saveability | A saveability status on every candidate; "listed" must not mean "Best will work". | **Done (D21, W3).** One `saveability` status per candidate and rendition, shown, respected by "Best" and refused by the manager. |
| F. Fixture-biased tests | Real-page-shaped fixtures; SW death as a manual gate, not a fake unit test. | **Done (W9).** Worker death automated; the rest is a written release checklist (TESTING.md § 5). |
| G. Thin security slice | Scheme allowlist, filenames, one caps policy, no double copies of a blob, sender rules. | **Done (W8).** Per-tab byte budget; assembly composes parts by reference (memory copy count is a checklist item). |
| H. Firefox: target or not | Say so; if a target, offscreen-vs-in-place is design work. | **Done (D19).** Chromium is the target; Firefox experimental. |
| I. Observability | Local, structured, no URLs; fix the diagnosis first. | **Done for now.** Diagnosis corrected; redacted clipboard export; no telemetry. |

The review's own ordered list is the basis of § 15.

---

## 14. Owner decisions — answered under delegation

The P0 questions were decided by engineering under the owner's standing delegation on 2026-09-25
(two opposed perspectives, a ruling, a record in ARCHITECTURE § 3 marked as such). The owner can
overturn any of them; each record says what changing it would cost.

| # | Question | Answer |
|---|---|---|
| **P0-1** | Durability | **D16** — (c): queued and browser downloads survive; in-flight segmented downloads are dropped with a visible, retryable trace. |
| **P0-2** | Target pages | **D17** — single-page-app players (History API, hash, Navigation API, iframes). |
| **P0-3** | Fetch identity | **D18** — the page as Referer to granted hosts; never cookies. |
| **P0-4** | Browsers for 0.1.x | **D19** — Chromium; Firefox experimental. |
| **P0-5** | "Best" | **D20** — sound, then resolution, then bitrate; a split stream brings its audio. |
| P1-6 | Detected but not saveable | **D21** — shown, marked, disabled, refused. |
| P1-7 | Origin policy | Open: any origin, one grant at a time. |
| P1-8 | Hard caps per task | Open: named caps with clear refusals for segmented downloads; direct files limited by the browser. |
| P1-9 | MVP or general downloader | Open: README says pre-alpha. |
| P1-10 | Cancel after hand-off | Unchanged: a stop before hand-off prevents the dialog; after hand-off the file is taken back. |

---

## 15. The runway — what to do next, and what not to do

### 15.1 Workstreams, in order

The order follows the external review, adjusted for what 0.1.5 already delivered. W1–W9 were
delivered in 0.1.6; W10 is next.

| # | Workstream | Done when |
|---|---|---|
| **W1** ✓ | Owner answers P0-1 … P0-5. | Each answer recorded as a decision (ARCHITECTURE format) and reflected in § 14. |
| **W2** ✓ | **Durability contract.** Turn § 6.2 into policy: every cell decided as *survive*, or *drop with a visible trace in the UI*. Implement what P0-1 requires (at minimum: record completions that happen while no worker runs; release or close the offscreen document's orphaned blobs). | No **?** cells; manual gates for worker death written and run. |
| **W3** ✓ | **Saveability in the model.** One status per candidate (saveable, needs a rendition, DRM, encrypted, MSE-only, too large, live, unknown), decided at detection where possible, shown by the popup, respected by "Best download". | "Listed" never means "fails on click" for a reason known before the click. |
| **W4** ✓ | **"Best" as a written rule** (from P0-5), with fixtures: worst-first ladders, separate audio, "4K video-only vs 1080p with sound", progressive file vs stream of the same media. | Rule stated in ARCHITECTURE; tests for each fixture. |
| **W5** ✓ | **Fetch identity** (from P0-3): if "look like the tab", a `declarativeNetRequest` header rule scoped to the task's hosts and lifetime, and a decision on credentials; either way, a diagnosis for "detected, but this site will not serve it to MediaGrab". | Policy written in SECURITY.md; extension test pins what reaches the server. |
| W6 ✓ | Remaining navigation gaps: hash routes, Navigation API, query-only `pushState` (decided: a new route, D17), late injection. | Single-detector fixture per case. |
| W7 ✓ | Document the pause/cancel/illegal-transition table next to the state machine (it exists in code; it should be readable in one place). | A table in ARCHITECTURE. |
| W8 ✓ | Resource caps completed: per-tab session-storage bytes; verify assembly never holds two full copies. | Caps named in `core/limits.ts` or beside the code that enforces them. |
| W9 ✓ | Chromium manual release gates as a checklist: prerender → activation; worker death during download, pause, and completion; the permission prompt. | Checklist in TESTING.md, run before a release. |
| W10 | Next: Firefox (run it with `web-ext`, then decide whether it becomes a target), origin policy (P1-7), debug export improvements; wire the Referer for two tabs sharing one CDN if it shows up in use. | — |

### 15.2 Do not

- Start a third SOLID refactor. The structure is right; the remaining risk is behaviour, durability and
  fixtures.
- Grow `DownloadRequest` again; add back the `stream-copy` strategy or a `priority` field without a
  feature that reads them.
- Add telemetry, analytics or any upload.
- Load adapters remotely without a signing, verification and revocation story (D7).
- Treat an origin allowlist as a security fix — it is a product decision (P1-7).
- Assert a browser behaviour in a unit test and call it verified; say "unit-tested against the
  documented behaviour" and add a manual gate.

---

## 16. Working agreements

How the owner has asked work on this repository to be done.

- **One project at a time.** Finish a package (build, review, audit) before starting another; parallel
  work stays inside one package.
- **Delegated decisions.** Routine product and engineering questions are resolved by engineering — two
  opposed perspectives, a ruling, a logged decision marked as made under delegation — and then executed.
  Stop only for: IP or licensing, spending money, destructive or irreversible actions, credentials,
  migrations that could corrupt data. The P0 questions in § 14 were answered this way in 0.1.6.
- **No permission checkpoints.** Do not stop to ask "shall I continue"; run the agreed work to the end
  and report.
- **Committing and pushing is the owner's call.** Before a change that cannot be undone, snapshot.
- **Every behaviour change updates the docs in the same pass**: CHANGELOG (Keep a Changelog),
  ARCHITECTURE decisions (Context · Options · Choice · Why · Trade-offs), TESTING, the `extensive.md`
  ledger and histories, and this book.
- **Honesty over polish.** Known limitations are listed plainly; nothing is stubbed to look finished;
  metrics are never gamed.

---

## 17. Lessons and traps

- **Keep `fetch`'s receiver.** A detached `fetch` works in a service worker and throws in a Window (the
  offscreen document). Unit tests that inject a fetch cannot see this. Use `core/fetch.ts`.
- **Forbidden headers are dropped silently.** Setting `Referer` from script does nothing; a
  `declarativeNetRequest` session rule with `tabIds: [-1]` is the way (D18).
- **An offscreen document is listed while it is still being created**, before its script listens.
  Wait for the creation in flight, not just for `getContexts` to list it.
- **Stop a worker with `Target.closeTarget`**, and prove it with a marker; a new worker may start at
  once. `chrome.runtime.reload()` and prerender cannot be automated.
- **`frameId` 0 is the active page's outermost frame.** Prerendered pages have non-zero frame ids and a
  `prerender` document lifecycle until shown.
- **A fixture where two detectors see the same media hides bugs in either.** One detector per fixture.
- **The extension test suite runs in serial mode**: after one failure the rest are skipped, not passed.
- **Playwright renames extension downloads** into its artifacts; assert through the extension's state
  and the browser's download record.
- **Firefox pause is an interruption** with a paused flag; do not read it as a cancel.
- **A per-tab badge overrides the global one**, so a global download badge never shows where downloads
  start.
- **`storage.session` is not durable across a browser restart or an extension update/reload**, and is
  per-extension in-memory. `storage.local` is; keep URLs out of it.
- **Every fix is a new surface.** Every audit so far found regressions introduced by its own fixes
  (0.1.6: a save made failure-safe that then rewrote the queue four times a second while storage was
  full); always run a verification round, with the same reviewers.
- **Two fixes for one bug hide each other from a mutation check.** Revert both together to prove the
  test covers the bug.

---

## 18. Glossary

| Term | Meaning here |
|---|---|
| Candidate | One detected media resource, built by the worker (`detection/candidate.ts`). |
| Claim | What a page reports about a URL; never trusted as a candidate (D14). |
| Report | One `PAGE_REPORT`: a frame's complete current state. |
| Route | A page's current single-page-app route; starts at `routeStartedAt`. |
| Variant / rendition | One quality of a stream (a rung of the ladder). |
| Ladder | A stream's set of renditions. |
| Master playlist / media playlist | HLS: the list of renditions / the list of one rendition's segments. |
| MPD, Period, AdaptationSet, Representation | DASH manifest structure. |
| Segment plan | The one shape both formats compile to before a byte is fetched. |
| Engine | How a task's bytes arrive (`browserEngine`, `segmentedEngine`). |
| Hand-off | The moment the browser is given the file to write. |
| Slot | One of the concurrent downloads the settings allow. |
| MSE / EME | Media Source Extensions (the player assembles media in JavaScript) / Encrypted Media Extensions (DRM). |
| Offscreen document | Chrome's hidden extension page used for assembly. |
| Test build | `dist/chrome-test`: the shipping build plus fixture-host permissions and declarative scripts. |
| Grant | A user's per-origin host permission. |
| Saveability | Whether a candidate or rendition can be saved, and why not (D21). |
| Trace | The URL-free record of an unfinished task kept across updates and restarts (D16). |
| Referer rule | A session header rule naming the page to one host, for a task's lifetime (D18). |

---

*Last reconciled with the code: 0.1.6, 2026-09-25.*
