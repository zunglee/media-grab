# MediaGrab — code and flow audit, SOLID simplification, re-audit

**Date** 2026-09-25 · **Package** `media-grab/` v0.1.3 → v0.1.4 · **Scope** every runtime module under `src/`
(background, content, page hook, detection, downloads, offscreen, permissions, storage, UI bridge);
the pure parsers under `manifests/` and `media/` were read for contracts, not re-audited line by line.

Decided by engineering under owner delegation: the request named no package, so the audit took the
last package worked on (media-grab, re-audited 2026-09-08), whose flows are the longest in the repo.

---

## 0. Baseline before any change

| Check | Result |
|---|---|
| `pnpm test` (Vitest) | 131 / 131 pass |
| `pnpm typecheck` (svelte-check + tsc) | 0 errors, 0 warnings |
| `pnpm lint` (Biome) | clean, 84 files |
| `pnpm test:e2e` (real Chromium, test build + UI harness) | 29 / 29 pass |
| knip (unused exports) | 8 exports, 2 types |

A snapshot of the source was taken before editing, because the repository has no commits yet and
therefore no git undo.

---

## 1. Pass 1 — findings

Severity: **High** = wrong result for a normal user action. **Medium** = wrong result in a common
situation. **Low** = waste, dead weight or misleading data with no user-visible failure.

### 1.1 Flow bugs

| # | Sev | Where | What goes wrong |
|---|---|---|---|
| B1 | High | `background/index.ts` `downloadBest`, `ui/popup/Popup.svelte` `downloadBest` | "Best download" (popup button, `download-best` shortcut, context-menu item) takes `variants[0]` — the **first rendition in manifest order**, not the best. Many real HLS masters list the lowest rung first, so the primary button can save 240p. The row-level button uses `recommend()` and is right, so the two "best" buttons disagree. The fixture ladder is listed best-first, which is why no test caught it. |
| B2 | High | `background/index.ts` `PAGE_CONTEXT`, `content/index.ts` | The content script runs in **every frame** (`allFrames: true`) and every frame reports `location.href` as the page URL. The worker keys state by tab only, so a same-origin iframe (or any iframe once "all sites" is granted) looks like a navigation: it wipes the tab's network candidates and DOM candidates, then the top frame flips it back, and so on. The scan's page URL and title can be the iframe's. **Reproduced in Chromium against 0.1.3** (page with an embedded player: the scan never holds both frames' media). |
| B3 | **High** | `content/index.ts` `runScanAndReport`, `background/index.ts` | One DOM pass sends two fire-and-forget messages (`CANDIDATES_FOUND`, then `PAGE_CONTEXT`). The worker handles them concurrently with read-modify-write on `storage.session`; `PAGE_CONTEXT` reads the context before the candidates are written and writes it back after, erasing them. Every repeat pass loses the same race. **Reproduced in Chromium against 0.1.3:** a page whose only media is a `<video preload="none">` never shows anything. The fixture page used by the old tests hid it, because its video is also fetched and so seen by the network observer. |
| B4 | Medium | `REQUEST_SCAN` handler | "Scan again" asks the content script to rescan and **does not wait for it**: the scan runs on the stored DOM state. The `deep` flag the popup sends is ignored everywhere. Found by reading; it could not be shown in isolation against 0.1.3 because B3 breaks detection first. |
| B5 | High | `downloads/manager.ts` `command('pause')` | Pausing a **direct-file** download aborts a controller that the browser download does not listen to. The browser keeps downloading; its completion is then refused (`PAUSED → COMPLETED` is illegal) so the task sits at "paused"; pressing Resume starts a **second download of the same file**. The header comment says the browser pauses these — the code never asks it to. **Reproduced in Chromium against 0.1.3:** after Pause the browser's own record still reads `paused: false`. |
| B6 | Medium | `downloads/plan-builder.ts` `fetchText` + `manager.run` | Pausing a segmented download while its manifest is being fetched turns the abort into `NETWORK_ERROR`, which is retryable, so the manager moves the task `PAUSED → FAILED → QUEUED` and **restarts it** behind the user's back. |
| B7 | Low | `downloads/segment-fetcher.ts` | After a segment fails every retry the fetcher still downloads every remaining segment, although the assembler throws the whole result away on any gap — up to 1.5 GB of wasted transfer. After a `DISK_ERROR` the other workers also keep fetching. |
| B8 | Low | `storage/history.ts` | `candidateId` is written as the task id. Nothing reads it. |
| B9 | Low | content → engine → `diagnose` | `domElements` is the number of DOM *candidates* (links and meta tags included) but diagnosis reads it as the number of media *elements* ("a player is on the page but has not started"). |
| B10 | Medium | `manager.enqueue` → `runSegmented` | An HLS **media** playlist found on its own (no master above it) is expanded with `variants: []`. Downloading it picks the segmented strategy with no variant and fails with `INTERNAL` "A segmented download requires a selected variant" — a whole class of streams that detects fine and can never be saved. |
| B11 | Low | `background/index.ts` message handler | Privileged messages (`START_DOWNLOAD`, `DOWNLOAD_COMMAND`, `SETTINGS_CHANGED`) are accepted from any sender, including content scripts running inside web pages. Pages cannot forge runtime messages directly, so this is defence in depth, but the trust rule the code documents ("content-script output is untrusted input") is not enforced by sender. |

### 1.2 Design debt (SOLID)

| # | Principle | Where | Finding |
|---|---|---|---|
| D1 | SRP | `background/index.ts` (364 lines) | One file is the tab-state store, the scan orchestrator, the message router, the history recorder, the notifier, the command and context-menu handler and the boot wiring. "Scan and broadcast" is written out three times, "tab from event or active tab" twice. |
| D2 | SRP / OCP | `downloads/manager.ts` (514 lines) | Queue, concurrency, retry policy, filename/request building, browser-download polling and the segmented pipeline in one class; each new strategy means editing `run()`'s `if`. |
| D3 | DIP | `detection/network.ts`, `downloads/assembly-host.ts` | Both reach for `chrome.*` directly, breaking the codebase's own rule (ARCHITECTURE D2: only `src/browser/` touches the namespace). |
| D4 | DRY | `detection/manifest-loader.ts`, `downloads/plan-builder.ts` | Two copies of "fetch a manifest as text with a timeout, no credentials, map HTTP status to an error code" that have already drifted (only one maps aborts, neither maps a user abort to `CANCELLED` — the root of B6). |
| D5 | ISP / YAGNI | `storage/settings.ts`, `core/download-types.ts`, `core/messages.ts` | Eight settings nothing reads (`defaultQuality`, `preferredFormat`, `scanAfterPlay`, `floatingButton`, `preferHighestQuality`, `downloadSubtitles`, `downloadThumbnail`, `telemetry`); a `stream-copy` strategy, `audioUrl`, `priority` and `audioVariantId` with no implementation; eight unused exports (knip). |

### 1.3 What is already good and was left alone

- The trust boundary: every inbound message is shape-checked, candidates are rebuilt rather than
  forwarded, and the page hook only ever posts a namespaced envelope.
- The pure core (`manifests/`, `media/`) — small modules, one job each, well tested, honest comments.
- Error classification (`core/errors.ts`) and the refusal to ship broken files (DRM, AES-128, gaps).
- The state machine as the single writer of task state.

---

## 2. What changed

### 2.1 Structure

| Before | After | Principle |
|---|---|---|
| `background/index.ts`, 364 lines, eight jobs | `index.ts` (95, composition root only) · `services.ts` (collaborators, lazy settings/manager, "best download") · `message-router.ts` (one handler per message; exhaustive by type; sender rule) · `tab-store.ts` (pure `applyReport` fold + per-tab serialised storage) · `scanner.ts` (one scan per tab in flight, one shared follow-up, broadcast) · `download-hooks.ts` (badge, broadcast, history, notification) · `paused-downloads.ts` | SRP |
| `downloads/manager.ts`, 514 lines, `if` on strategy | `manager.ts` (queue, slots, states, retries) · `task-factory.ts` (pure: rendition, strategy, filename) · `engines.ts` (`DownloadEngine`: `browserEngine`, `segmentedEngine`; the engine owns its blob) · `browser-progress.ts` (polling) | SRP, OCP, testable through fake engines |
| `chrome.*` in `network.ts`, `assembly-host.ts`, `offscreen/index.ts` | only in `src/browser/`; `BrowserApi` gained `downloads.pause/resume`, `webRequest.isAvailable`, `offscreen`, `tabs.sendMessage(…, {frameId})`, and lost eight members nothing called | DIP, ISP |
| two manifest fetchers, drifted | `core/fetch.ts` `fetchManifestText` (timeout, size cap, no credentials, one error classification, caller abort = `CANCELLED`) | DRY |
| `CANDIDATES_FOUND` + `PAGE_CONTEXT`, racing | one `PAGE_REPORT` per frame, full state, folded one at a time per tab | — |
| 8 dead settings, `stream-copy`, `priority`, `audioUrl`, `audioVariantId`, `deep`, referer plumbing, 5 dead request fields, `segmentsObserved`, 8 unused exports | removed; knip now clean with a package config (`registerAdapter` tagged `@public`) | YAGNI |

Size: `src/` code lines (comments and blanks excluded) 6,986 → 7,260 (+4 %), while adding in-browser
pause/resume, paused-download carry-over, scan coalescing, the sender rule, the frame rules and
prerender separation. The largest file stayed about the same size (514 → 513 lines) but now does one
job; the worker entry went from 364 to 95. Bundles, gzip: background 26.7 → 29.1 KB (budget 40),
content 6.3 → 6.6 KB (15), popup 26.5 → 26.6 KB (60). Unpacked extension 200 → 207 KB (500).

### 2.2 Proof, not just tests passing

Three pass-1 bugs were reproduced **in Chromium against the untouched 0.1.3 build** with the new
extension tests before the fix was trusted (B2 iframe, B3 DOM-only media, B5 pause). The regression
tests for B1, B6, B10 and L4 were mutation-checked: removing the fix makes the test fail.

---

## 3. Pass 2 — independent re-audit

Two reviewers with no part in the change read the diff against the pre-change source: one for
correctness and flow, one for design and readability. Every finding was checked against the code
before acting on it.

### 3.1 Correctness and flow — no High

| # | Sev | Finding | Fix |
|---|---|---|---|
| M1 | Medium | Any top-level response — a link that downloads a file, a 204, a prerender — reset the tab's network media although the page stayed. | `replacesVisiblePage()`: frame 0, not 204/205, not `attachment`. Content script silent while `document.prerendering`. |
| M2 | Medium | A fragment change counted as navigation and dropped an embedded player's media; "Scan again" re-asked only the top frame. | Navigation ignores the fragment; every frame re-reports, the top frame's reply is awaited. |
| M3 | Medium | Delegating pause to the browser left the paused partial file orphaned once Chrome stopped the idle worker (~30 s). A consequence of the B5 fix. | `paused-downloads.ts`: browser-paused tasks kept in `storage.session`, adopted again if the browser still has them. |
| L4 | Low | Cancelling just after the last segment could still open a Save dialog. | Abort check before hand-off; blob released. |
| L5 | Low | "Scan again" ran two scans back to back with auto-scan on. | `scan(tab, {notBefore})` joins the scan its own report started. |
| L6 | Low | A failed manager start was cached for the worker's life. | Reset on failure. |
| L7 | Low | A scan finishing after its tab closed wrote the record back. | Closed-tab set; `saveScan` skips it. |

Checked clean by the reviewer: sender checks (popup, options in a tab, Firefox pages), slot accounting,
retries, completion-once, cancel-after-hand-off, segment fail-fast.

### 3.2 Design and readability

Verdict: "each new module has one job, and the headers explain why and trace the flow";
`BackgroundServices` judged a composition object, not a new god object. Acted on:

- Finished the Referer removal (a no-op round trip through three functions) and fixed the two comments
  that said the opposite of the code.
- Trimmed `DownloadRequest` to the fields something reads.
- Moved blob ownership into the engine (`Handoff.release`), so the manager no longer knows blobs exist.
- Moved the navigation rule into `NetworkObserver.topFrameReported`; one `services.autoScan`.
- One scanner entry point that broadcasts once per scan.
- Router handler map made exhaustive (a missing handler is a compile error).
- One name per signal (`hasMediaSource` / `hasEncryptedMedia`).
- Six stale comments fixed; the "PRD sNN" references explained in ARCHITECTURE.md (they cite the
  owner's brief, which is not in the repository) rather than deleted.
- Doc drift fixed across README, ARCHITECTURE, SECURITY, TESTING, PERFORMANCE, extensive.md.

Not acted on, with reasons: collapsing `segment-hls`/`segment-dash` into one strategy (the value is
shown in fixtures and diagnostics, and costs nothing); removing `DownloadRequest` entirely (it is now
seven fields, all read).

### 3.3 Verification of the pass-2 fixes

The correctness reviewer re-read the fixed tree. L4–L7 confirmed fixed; M3 fixed for the reported case.
Four further items, all fixed and tested:

| # | Sev | Finding | Fix |
|---|---|---|---|
| M1′ | Medium | A page can also become a download by its type alone (`application/zip`, no `attachment` header), which still reset the tab. | Only content types the browser shows as a page (text, image, audio, video, PDF, JSON, XML) start one. |
| N1 | Medium | A prerendered page's requests (Speculation Rules) were filed under the page on screen, then lost when the prerendered page was shown. | Kept per prerendered frame (`documentLifecycle: 'prerender'`), adopted by `topFrameReported` when the user lands on that URL, dropped otherwise. The content script stays silent until the page is shown. |
| N2 | Low | "Scan again" could join a report built before it was asked. | Joins only the report made for its own request id. |
| N3 | Low | A download paused in MediaGrab, then resumed from the browser's download list while no worker ran, came back "paused" and failed on Resume. | Adopted with the browser's real state (`paused` is back on `DownloadItemInfo` for this). |

---

## 4. Final state

| Check | Before | After |
|---|---|---|
| Unit tests (Vitest) | 131 | **177**, all pass |
| Playwright (13 UI + extension in real Chromium) | 29 | **34**, all pass |
| Typecheck | 0 errors | 0 errors |
| Lint (Biome) | clean | clean |
| knip (package config with real entry points) | 8 unused exports, 2 types | **0** |
| Repo audit framework, static (`run.mjs audit media-grab --no-server`) | — | typecheck, lint, test, build, secrets, docs drift: PASS. `pnpm audit` FAIL is sibling packages' dependencies in the shared lockfile (Astro, drizzle-orm, sharp); MediaGrab ships zero runtime dependencies. Raised as a separate task. |

Mutation checks: removing the fix for B1, B6, B10 or L4 makes its regression test fail. Real-browser
reproduction against 0.1.3: B2, B3, B5.

### 4.1 Still open, stated plainly

- **History-API navigations and iframes.** On a same-document navigation, an iframe's re-report and
  the top frame's navigating report can arrive in either order; if the iframe's lands first it is
  dropped with the old page and returns on its next report. Low.
- **Iframes inside a prerendered page** are not tracked until the page is shown.
- **The type rule is a heuristic.** A `video/*` response the browser cannot play is downloaded, yet
  counted as a page.
- **A download that finishes while no worker is running** is not written to history (its record is
  dropped at the next start, because the browser reports it complete).
- **The rest of the queue** (queued and in-flight segmented downloads) still does not survive a worker
  restart — extensive.md § 24, unchanged.
- **Firefox** still builds but has never been run.
- **Not verified in a real browser:** prerender behaviour (no Speculation Rules fixture) and the
  worker-restart carry-over (Playwright cannot stop an extension's service worker on demand). Both
  are unit-tested against the documented browser behaviour only.
