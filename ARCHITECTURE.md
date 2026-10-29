# MediaGrab — architecture

## 1. The shape of the problem

A media downloader fails in one of two ways. Either it hard-codes a thousand websites and dies of
maintenance, or it has one generic detector that works on the easy half of the web and nothing else.

The answer this codebase takes is a layered pipeline where the generic path always runs, always
produces a result, and site knowledge can only *refine* it:

```
   ┌────────────────── the page ──────────────────┐
   │                                               │
   │  DOM scan    page hook (MAIN)   Resource      │      background worker
   │     │            │              Timing        │            │
   │     └────── content script ◄─────┘            │     network observer
   │              claims (PAGE_REPORT)             │   (granted hosts only)
   └───────────────────┼───────────────────────────┘            │
                       ▼                                        ▼
       allow-list gate → rebuild candidates ──► tab store    candidates
                       └──────────────┬──────────────────────────┘
                                      ▼
                  collect → adapter adds → dedupe → adapter normalizes
                                      │
                  expand the best manifests (cached 30 s by URL)
                                      │
                  probe each master's best rendition → saveability (D21)
                                      │
                  drop playlists already listed inside a master
                                      │
                  posters → score → rank → adapter re-rank → diagnose
                                      │
                               ScanResult  ──────────►  popup
                                      │
                          variant selection (user)
                                      │
              direct file / single-file DASH ─► browser download ─► disk
              HLS / DASH ─► plan builder (container) → segment fetcher → assembler
                                                                 └─► browser ─► disk
```

Everything above `ScanResult` is pure or near-pure and unit-tested in Node. Everything below it is
where the browser APIs live.

## 2. Module map

```
src/
  core/            types, error codes, message protocol (+ the allow-list gate),
                   hook-protocol (page hook <-> content script), limits (every
                   cap on page input, with its reason), redaction, logging,
                   fetch (the one manifest fetcher)
  browser/         the ONLY place chrome.*/browser.* is touched
  detection/       dom (claims + page signals), candidate (the one place a
                   candidate is built), network, manifest-loader, manifest-cache,
                   saveability (D21), engine, diagnose
  inject/          page-hook.ts — a MAIN-world content script, the page's own JS context;
                   routes.ts — what counts as a new route (D17)
  manifests/       hls/ (parser, attributes, segments), dash/ (xml, duration, model,
                   segment-info, parse, segments), segment-plan (shared shape and
                   size cap), url, drm-systems
  media/           format (incl. classifyMediaUrl, the one "is this media?" rule),
                   fingerprint, dedupe, score, quality (incl. "best download", D20),
                   saveability, naming
  downloads/       manager (queue, states, retries), task-factory, engines,
                   referer-rules (the page as Referer, D18), interrupt-reasons,
                   browser-progress, state-machine, progress,
                   plan-builder, segment-fetcher, assembler, assembly-host
  adapters/        types (contract), registry, sites/generic
  offscreen/       Chrome-only assembly document + its message protocol
  permissions/     per-origin site access, content-script registration
  storage/         settings, history
  background/      index (composition root), services, message-router,
                   tab-store, scanner, download-hooks, queue-store,
                   offscreen-lifetime, badge, context menus
  content/         content script entry
  ui/              popup, options, components, styles, harness;
                   lib/ (popup-controller, bridge, download-view, media-view)
```

Where a flow lives, end to end:

| Flow | Path |
|---|---|
| A page is detected | `content/index.ts` (DOM + page hook + Resource Timing, one `PAGE_REPORT` of claims per frame) → `core/messages.ts` (allow-list) → `background/message-router.ts` (`detection/candidate.ts` rebuilds each claim) → `background/tab-store.ts` (fold the report into the tab) → `background/scanner.ts` → `detection/engine.ts` → `storage.session` `scan:<tabId>` |
| A media request is seen | `detection/network.ts` (granted hosts) → `background/scanner.ts` |
| A single-page app changes route | `inject/page-hook.ts` (`pushState` / `popstate` / `hashchange` / Navigation API, judged by `inject/routes.ts`) → `navigate` → `content/index.ts` forgets the old route and reports at once → `tab-store.ts` sees a new `routeStartedAt` → `network.ts` keeps only what was fetched since |
| "Scan again" | popup → `REQUEST_SCAN` → worker asks the top frame for a fresh report and waits for it → `scanner.ts` |
| "Best download" | `media/quality.ts` `pickBestDownload` (popup, shortcut and context menu all use it) |
| A download | `START_DOWNLOAD` → `downloads/manager.ts` → `task-factory.ts` → `engines.ts` → browser; completion via `downloads.onChanged` → manager → `background/download-hooks.ts` (history, notification) |

Dependency rule: `core` depends on nothing; `manifests` and `media` depend only on `core`; `detection`
and `downloads` may use `browser`; `ui` may use everything but is the only layer allowed to render.

---

Source comments cite "PRD sNN": the section of the owner's original product brief a behaviour comes
from. The brief itself is not in this repository; `extensive.md` is the maintained description.

## 3. Decisions

Format: **Decision · Context · Options · Choice · Why · Trade-offs.**

### D1 — Svelte 5, not React

**Context.** The brief suggested React + Tailwind + Zustand. Every sibling project in this repository
is Svelte 5 or Astro, and the popup must open instantly.

**Options.** (a) React + Zustand + Tailwind as briefed. (b) Svelte 5 with built-in state. (c) No
framework, hand-rolled DOM.

**Choice.** (b).

**Why.** Svelte compiles away, so the popup ships the component logic and not a runtime; the popup and
options bundles are 26 KB and 20 KB gzipped *including* the shared chunk. Zustand and Tailwind both
become dependencies that buy nothing here — Svelte's runes cover the state, and the design system is
about 130 lines of CSS custom properties. It also keeps one toolchain across the monorepo
(`svelte-check`, one Biome config, one Vite version).

**Trade-offs.** The brief named React, so this is a deliberate departure and is called out in the
CHANGELOG. If site adapters ever ship a UI written by third parties, React's ecosystem would matter
more than it does now. Reversing it means rewriting five components and the harness — a few hours.

### D2 — Browser abstraction, not `chrome.*` everywhere

**Context.** Chrome MV3 and Firefox MV3 differ in background type (service worker vs event page),
`storage.session` availability, offscreen documents, and promise support.

**Options.** (a) `webextension-polyfill`. (b) A hand-written `BrowserApi` interface. (c) Conditional
compilation with `__TARGET__`.

**Choice.** (b), with (c) available for the two places that need it.

**Why.** The interface is about thirty methods across a dozen namespaces, each one something the code
actually calls; the polyfill is a dependency that normalizes callbacks but does
not paper over the real differences (offscreen, session storage, background shape) — we would still
need our own layer on top. A hand-written interface also gives the tests an in-memory fake
(`src/ui/harness/fake-browser.ts`), which most worker and download tests run against. (The popup itself
is tested through the smaller `PopupBridge` seam, `ui/lib/bridge.ts`.) Option (c) was never needed:
the `__TARGET__` constant the build defined was never read, and was removed in 0.1.5.

**Trade-offs.** Every new API has to be added to the interface by hand. That friction is the point: it
keeps the surface small and forces a decision about cross-browser behaviour at the moment of use.

### D3 — A hand-written XML reader for DASH

**Context.** MPDs are XML. A Chrome MV3 service worker — the only context with host permissions for
cross-origin manifest fetches — has **no `DOMParser`**.

**Options.** (a) Parse in the content script and message the result back. (b) Bundle an XML parser.
(c) Write a small reader for the MPD subset.

**Choice.** (c) — `src/manifests/dash/xml.ts`, about 150 lines.

**Why.** (a) moves parsing into a hostile page's process and adds a round trip per manifest. (b) is a
general-purpose parser for a very specific job, and general XML parsers are where XXE lives. (c) is
small enough to read in one sitting, testable in Node, and it *refuses* DTD and ENTITY declarations
outright rather than trying to handle them safely.

**Trade-offs.** It handles the MPD subset, not XML. A manifest using processing instructions or exotic
entity forms will throw rather than parse. That is the correct failure — it surfaces as
`UNSUPPORTED_MANIFEST` with the manifest URL, which is actionable.

### D4 — Segment assembly in an offscreen document (Chrome) / in place (Firefox)

**Context.** `URL.createObjectURL` does not exist in an MV3 service worker, and the downloads API needs
a URL. Firefox's MV3 background is an event page with a DOM, so it does not have the problem.

**Options.** (a) Assemble in the SW and pass bytes to an offscreen document to blob-ify. (b) Do the
whole fetch-and-assemble inside the offscreen document and return only the blob URL. (c) `data:` URLs.

**Choice.** (b). `src/downloads/assembly-host.ts` picks the path at runtime by feature-detecting
`createObjectURL`, so one code path serves both browsers.

**Why.** (a) copies the entire file across a structured-clone boundary — for a 1.2 GB video that is a
1.2 GB copy. (c) has a hard size ceiling and is worse in every way. (b) keeps the bytes in one process.

**Trade-offs.** The offscreen document is a Chrome-only API, so `assembly-host` has a genuine branch.
Assembly still happens in memory (see D5).

### D5 — In-memory assembly, with a stated ceiling

**Context.** An extension cannot stream to disk. The File System Access API needs a window with user
activation and a persisted handle; an offscreen document cannot show a picker.

**Choice.** Assemble in memory, cap at 1.5 GB, and fail with `DISK_ERROR` and a plain-English message
above that.

**Why.** The alternative is a native companion application, which changes the distribution story
completely. Shipping a downloader that silently dies on large files would be worse than one that says
"this is too large for the browser to assemble".

**Trade-offs.** Long 4K downloads are out of reach until a native host exists. This is the single
biggest reason a v2 might need one. It is also why segmented downloads cannot be paused: there is no
partial file on disk to resume into.

### D6 — Optional host permissions, per origin

**Context.** "Read and change all your data on all websites" is the permission users have learned to
fear, and store reviewers scrutinise it.

**Options.** (a) `host_permissions: ["<all_urls>"]` with a declarative content script. (b) `activeTab`
plus optional host permissions, granted per origin from a click.

**Choice.** (b) — and, since 0.1.2, `webRequest` is optional and granted in the same click.

Chrome warns at install when `webRequest` is declared with no host permissions: *"You need to request
host permissions in the manifest file in order to be notified about requests from the webRequest API."*
That warning is accurate — a `webRequest` listener with no host permission never fires, which was
verified: with the shipping build installed and nothing granted, a page load produced no scan at all.
Declaring a permission that cannot do anything is both a worse install prompt and a false promise, so
`webRequest` moved to `optional_permissions` and `NetworkObserver.start()` now takes the granted origin
patterns instead of `<all_urls>`, and is re-run whenever a grant arrives.

**Why.** It is the honest version of what the extension needs, it makes the permission dialogue
specific ("example.com" rather than "all websites"), and it is a real differentiator in a category
where the incumbents ask for everything.

**Trade-offs.** Real, and stated in the UI: the network observer only sees requests made after the
grant, so the first grant on a site needs a page reload. Users who dislike being asked can grant all
sites from the options page in one click. Anyone who granted origins before 0.1.2 will be asked once
more, because they do not yet hold `webRequest`. Firefox keeps `webRequest` static, since that build is
unverified and this was not the change to discover it with.

### D7 — Adapter distribution: bundled only, for now

**Context.** The brief's most ambitious idea is signed adapters delivered at runtime so a broken site
can be fixed without shipping a new version.

**Choice.** Build the adapter *contract* and registry now (`src/adapters/`); do **not** implement remote
loading.

**Why.** Runtime-loaded code in an extension with `downloads` permission is a supply-chain attack
surface with a key-management problem attached. It needs a signing key, a verification path in the
worker, a revocation story, a review process, and a CSP that permits it — none of which exists. Half of
that shipped is worse than none. The registry is designed so adding it later is a change to one file.

**Trade-offs.** Site breakage needs a release until then. `registerAdapter()` is exported so bundled
adapters can be added without touching the engine.

### D8 — Score, do not filter

**Context.** Generous detection produces noise. Aggressive filtering hides the one thing the user wanted.

**Choice.** Every candidate gets a 0–100 score with a list of reasons. The popup shows candidates ≥ 25;
everything else stays in `ScanResult.rejected` with its reason and is visible in Power mode and in the
diagnostics export.

**Why.** It makes "why isn't my video here?" answerable — the reasons are literally in the object. It
also makes the threshold a tuning knob rather than a rewrite.

**Trade-offs.** The weights in `src/media/score.ts` are judgement, not measurement. They are unit-tested
for the *relations* that matter (a 4K ladder beats a thumbnail; an ad path loses 30 points) rather than
for exact values, so they can be retuned without rewriting tests.

### D9 — Rebuild segment plans at download time

**Context.** An MV3 service worker is killed aggressively. A plan captured during the scan may be
minutes old by the time the user clicks download.

**Choice.** `plan-builder.ts` re-fetches and re-parses the manifest when the download starts.

**Why.** It removes a whole class of "worked in testing" bugs, and it is correct for live and
short-TTL manifests, where a cached plan is wrong by construction.

**Trade-offs.** One extra manifest fetch per download. Cheap next to the media itself.

### D10 — A test build, rather than no integration test

**Context.** The shipping manifest asks for no host permissions, so an automated browser cannot reach a
state where media is detected: the grant is a browser-native prompt no test can script.

**Options.** (a) No real-browser test — the position v0.1.0 shipped with. (b) Test-only manifest changes.
(c) Drive the permission prompt with OS-level automation.

**Choice.** (b). `dist/chrome-test` is the Chrome build plus two manifest changes: host permissions for
127.0.0.1 and localhost, and the two content scripts (the page hook in the MAIN world, then the
content script) declared instead of registered at run time.

**Why.** The first real run of that suite found three bugs, one of which broke every HLS and DASH
download on Chrome and was invisible to unit tests by construction (they inject a `fetchImpl`, so the
detached-`fetch` bug could not appear). (c) is fragile and platform-specific.

**Trade-offs.** The two changed lines are the two the tests cannot cover, so the permission-grant flow
and dynamic content-script registration remain unverified. The test build is never published, and
`pnpm test:e2e` rebuilds it so it cannot go stale against the source.

---

### D11 — One report per frame, and only the top frame names the page

**Context.** Until 0.1.3 a DOM pass sent two messages (`CANDIDATES_FOUND`, `PAGE_CONTEXT`) and every
frame reported its own URL as the page's. The worker handled the two concurrently with
read-modify-write on session storage, and keyed state by tab only. The first lost updates (a page whose
only media was in the DOM showed nothing); the second made every iframe look like a navigation.

**Options.** (a) Keep two messages and add locking. (b) One message carrying the frame's whole state,
folded into the tab by a pure function, applied one at a time per tab.

**Choice.** (b). `PAGE_REPORT` is always the frame's complete state, never a delta. `tab-store.ts`
`applyReport` holds the rules: only frame 0 sets the page URL and title and can trigger a navigation
reset; a sub-frame contributes candidates and page signals; a frame's report replaces its own earlier
candidates. `TabStore` serialises updates per tab. Since 0.1.5 a navigation is a new `routeStartedAt`
from the top frame, not a different URL (D13).

**Why.** A full-state message makes a lost or reordered report harmless — the next one repairs it —
and a pure fold is testable without a browser. The network observer resets a tab at the `main_frame`
response, the true start of a navigation, so the new page's early manifest requests are kept.

**Trade-offs.** A report re-sends every candidate the frame remembers (capped at 200 per frame, 1,000
per tab; `core/limits.ts`), which is more
bytes per message than a delta. A sub-frame's report that arrives before the top frame's after a
navigation is dropped with the old page; its next report (mutations, the 2.5 s late pass) restores it.

### D12 — Download engines behind one interface

**Context.** The manager decided both *when* a task runs and *how* its bytes arrive, with an `if` on the
strategy in `run()`, and paused direct files by aborting a controller the browser never listened to.

**Choice.** `engines.ts`: a `DownloadEngine` with one method, `start(run) → Handoff`, and two facts:
`browserFetches` (the browser holds the partial file, so pause and resume are its job) and
`retriesItself` (the engine already retried each piece, so the manager must not rerun the whole attempt
on top — the segmented engine retries per segment). The manager owns the queue, slots, states and
retries. A `Handoff` may carry the file name the engine actually saved under (D15).

**Why.** A new way to download (a native host, a muxer) becomes a new engine instead of an edit to the
manager, and the manager is testable with fake engines — which is how its pause, retry and slot rules
are now unit-tested.

**Trade-offs.** One more file and interface. `concurrentDownloads` now counts direct files that the
browser is fetching, which it did not before.

### D13 — See the page from inside: a registered MAIN-world hook, Resource Timing, and route times

**Context.** A site grant is one host, and a `webRequest` listener only fires for granted hosts, so a
manifest served from a CDN host was invisible to the network observer on most real sites. The page hook
that could see it was injected with a `<script>` tag after `DOMContentLoaded` — after the player had
often fetched its manifest — and from a web-accessible file any site could probe to learn MediaGrab was
installed. Its XHR check never ran (its `{ once: true }` listener was spent by `open()` itself), and a
single-page app's route change or a `replaceState` tidying the address were told apart by URL, which
gets both wrong.

**Options.** (a) Ask for every CDN host too. (b) Observe from inside the page: register the hook as a
MAIN-world content script (Chrome 102+, Firefox 128+) and read Resource Timing, which lists every URL
the document fetched, whatever the host. (c) `webNavigation` for route changes — another install warning.

**Choice.** (b). `permissions/content-scripts.ts` registers `page-hook.js` (MAIN) and `content.js`
(ISOLATED) at document_start; the manifest has no web-accessible resources. The hook reports `navigate`
when the route changes - by `pushState`/`popstate`, by a route-like hash (`#/…`, `#!…`, D17), or by
the Navigation API (`inject/routes.ts` decides, and whichever signal sees the change first reports it,
once); the content script stamps each report with `routeStartedAt` (the
document's time origin, or the moment of a route change or back-forward-cache restore), and a new value
from the top frame is what a navigation is. The network observer cuts its per-tab state at that time,
so a manifest the new route fetched before its report is kept.

**Why.** It finds what users see on real sites without asking for more hosts, removes the fingerprinting
surface, and makes "is this a new page?" a fact the page states rather than a guess from URLs.

**Trade-offs.** The hook and the content script start in no promised order, so the content script asks
the hook to replay (`hello`). Resource Timing gives URLs without types, so an extensionless manifest is
found only by the hook. A player running in a Worker is seen by neither.

### D14 — Pages send claims; the worker builds candidates

**Context.** Until 0.1.4 a content script sent finished `MediaCandidate` objects, shape-checked on
`url` and `kind` only; a page could pre-set `variants` (which skipped manifest expansion), a score, or
a `javascript:` URL.

**Choice.** `PAGE_REPORT` carries `ReportedCandidate` claims — an http(s) URL, a kind, where it was
found, and what the page says about it — allow-listed field by field in `core/messages.ts`.
`detection/candidate.ts` is the one place a candidate is built, for claims and network observations
alike.

**Why.** The trust boundary the docs always described is now enforced where the data crosses it.

**Trade-offs.** A few more lines per field. A new field a page may legitimately report has to be added
to the allow-list on purpose.

### D15 — The segment plan decides the container

**Context.** The file name was fixed when the task was queued, from the protocol alone, so every HLS
rendition was saved as `.ts` — fMP4/CMAF ones included — although only the media playlist says what its
segments are.

**Choice.** `plan-builder.ts` returns the plan with its container (EXT-X-MAP → mp4, packed audio →
aac, else ts; DASH mp4 or webm). The segmented engine corrects the extension and MIME type before
handing the blob to the browser, and reports the name it used. A single-file DASH representation is
not segmented at all: it is offered as a plain file and downloaded by the browser.

**Trade-offs.** The popup shows the first guess until the download starts.

### D16 — Durability: what survives the worker, an update and a restart

*Decided by engineering under owner delegation, 2026-09-25 (runway P0-1).*

**Context.** A Chrome MV3 worker is stopped when idle and killed on update; `storage.session` survives a
worker restart but is cleared by an extension update or reload and by a browser restart;
`storage.local` survives both. Until 0.1.5 the queue lived in worker memory, so a stopped worker lost
every task except a direct file paused in the browser.

**Options.** (a) Nothing in flight survives. (b) Browser-held downloads only. (c) The queue and every
browser-held download. (d) In-flight segmented downloads resume where they stopped.

**Choice.** (c), with a visible trace for what cannot survive.

- **Worker stop or kill: every task survives.** The queue is written to `storage.session` on every
  structural change. On the next start: queued tasks are queued again; anything the browser holds
  (a direct file running or paused, a segmented file already handed over) is re-adopted from the
  browser's own record — finished, paused, running, or gone; a segmented download caught while
  planning, fetching or assembling becomes *failed: interrupted*, with Retry (its plan is rebuilt
  anyway, D9).
- **Extension update or reload, browser restart:** session storage is gone, so a URL-free trace in
  `storage.local` (name, kind, state, the browser's download id) is what remains. Tasks the browser
  still holds are re-adopted by id; the rest are listed as *interrupted by an update or
  restart*, without Retry — no URL was kept to retry with — until the user removes them.
- **Completions while no worker runs** are found at the next start and written to history.
- **The offscreen document is closed** whenever no segmented download is fetching, assembling or
  being written, which also frees anything a killed worker left in it.

**Why.** A download manager that forgets queued work is not one; but keeping signed URLs on disk
across restarts would keep bearer tokens in storage (the reason history stores none) and could start
downloads the user no longer wants when the browser opens.

**Trade-offs.** After an update or restart, an unfinished segmented download has to be found again by
scanning the page. (d) needs segment parts on disk (IndexedDB in the offscreen document) and is left
for a later version.

### D17 — Target pages: single-page-app players first

*Decided by engineering under owner delegation, 2026-09-25 (runway P0-2).*

**Context.** Most video is played by single-page apps: the address changes without a new document,
players sit in iframes, and MediaSource players fetch a manifest. Until 0.1.5 only the History API
counted as a route change, so on a hash-routed app or one using the Navigation API the previous
route's media stayed listed as the current page's.

**Options.** (a) Static pages with a visible `<video>` — simple, and not what people use. (b)
Single-page-app players: every way an app changes route, iframes, MediaSource players whose manifest
can be fetched. (c) (b) plus capture of MediaSource-only media by recording its buffers — a different
product, with a different legal and technical footing.

**Choice.** (b). A route change is a new path (`pushState`, `popstate`), a new route-like hash (`#/…`,
`#!…`), or a Navigation API navigation; `inject/routes.ts` decides and whichever signal sees the change
first reports it, once. A query-only `pushState` (`/watch?v=1` → `?v=2`) is a new route: on many sites
that is the next video. `replaceState` only tidies the address. A plain anchor (`#comments`), a media
fragment (`#t=90`) and placeholder links (`#`, and `#!` or `#/` on a page with no hash route) are not
navigations. A content script injected late starts its route at injection. MediaSource media with no
manifest to fetch is explained, never saved.

**Why.** These are the pages people use; getting the route wrong is the worst failure a detector can
have — it offers the wrong video under the right title.

**Trade-offs.** More logic in the page hook, which is close to its size budget. Routers that write a
bare-path hash (`#video/2`) are not recognised: from the fragment alone that cannot be told from an
element id. A site that uses query-only `pushState` for filters drops the route's list and relies on
the page hook and Resource Timing to report the player's requests again.

### D18 — Network identity: no cookies added; the page as Referer where the browser allows it

*Decided by engineering under owner delegation, 2026-09-25 (runway P0-3).*

**Context.** Background fetches omit credentials and send no Referer (`fetch` drops it). CDNs that
refuse hot-linking answer 403, and the download fails as "link expired".

**Options.** (a) Stay a clean client. (b) Look like the tab: cookies and Referer. (c) Referer only,
through a `declarativeNetRequest` header rule where MediaGrab has host access; never cookies.

**Choice.** (c). A session rule sets `Referer` to the page URL on requests not tied to a tab to the
hosts a download fetches from — its manifest, init segment and segments, and any host that refused it
after a redirect — only where MediaGrab holds host access (`declarativeNetRequestWithHostAccess`,
which adds no install warning). It is removed when the last task using that host settles; a killed
worker's rules are cleared by the next worker at start, before it restores the queue
(`downloads/referer-rules.ts`). When a host MediaGrab has no access to answers 403, the failed row
names that host and offers "Allow … and retry" — the grant comes from the user's click, as every grant
does. A 401 is a session the user must have (`AUTH_REQUIRED`); no grant would help.

**Why not cookies.** `credentials: 'include'` makes a CORS request that fails against the
`Access-Control-Allow-Origin: *` most media CDNs send, so it would break downloads that work today;
and it would let a page's claims make MediaGrab send the user's cookies to any host.

**Trade-offs.** Referer reaches only hosts the user has allowed; the first 403 on a new CDN costs one
click. One rule per host carries the most recent page's URL. Scan-time manifest fetches send none, so
on a Referer-gated CDN a row may stay unexpanded and its saveability undecided until the download.
"Not tied to a tab" also covers a site's own service worker, and `requestDomains` covers subdomains:
while a task runs, those requests to the same host carry the page too — to a host that already
receives it from MediaGrab. A direct file is fetched by the browser's own download manager, which
sends the browser's cookies for that site as any download would; MediaGrab adds none.

### D19 — Browsers for 0.1.x: Chromium is the target

*Decided by engineering under owner delegation, 2026-09-25 (runway P0-4).*

**Context.** Chrome and Firefox differ exactly where MediaGrab depends on the platform: Chrome has a
service worker and an offscreen document; Firefox an event page with a DOM, a pause reported as an
interruption, MAIN-world registration from version 128. Playwright cannot load an extension into
Firefox, so only Chromium is exercised by the real-browser suite; the manifest and README presented
both as supported.

**Options.** (a) Chromium only; stop building for Firefox. (b) Chromium is the target and the release
gate; Firefox is built from the same source and labelled experimental. (c) Both are release gates —
which needs a way to run Firefox (`web-ext`, manual passes) that this project does not have yet.

**Choice.** (b). Chrome and other Chromium browsers are what the real-browser suite runs and what a
release is checked on (TESTING.md § 5). The Firefox build keeps compiling from the same source and is
labelled experimental and unverified; it becomes a gate once it can be run.

**Why.** Dropping the build would throw away working differences (in-place assembly, pause handling)
that cost little to keep compiling; calling it supported while nothing has run it would be untrue.

**Trade-offs.** Firefox users get a build nobody has run, labelled as such; every change must still
compile for it and keep its fakes honest.

### D20 — What "best" means

*Decided by engineering under owner delegation, 2026-09-25 (runway P0-5).*

**Context.** "Best download" — the popup button, the keyboard shortcut and the context menu — took the
highest combined quality score, so a 4K video-only rendition could beat 1080p with sound, and
MediaGrab has no muxer to join a silent video to its audio.

**Options.** (a) Highest resolution. (b) Highest bitrate. (c) Sound first, then resolution, then
bitrate. (d) Only what makes one playable file — which would never choose a split stream at all.

**Choice.** "Best download" takes the highest-ranked candidate that can be saved, in the rendition a
normal person can use: **sound first** (a rendition with audio over a video-only one), then
resolution, then bitrate, then the combined quality score (codec, frame rate). A stream that only
exists as separate video and audio gets both: the best video and its paired audio, as two files, and
the row says so. A rendition too large to assemble is skipped for the next one.

**Why.** Without a muxer, the highest resolution is often a silent file; a person who asked for "the
best version" wants to watch it with sound.

**Trade-offs.** On a stream that offers 4K video-only next to 1080p with sound, Best gives 1080p; the
4K rendition is one click away in the row.

### D21 — Every candidate says whether it can be saved

*Decided by engineering under owner delegation, 2026-09-25 (runway P1-6).*

**Context.** Rows were listed whether or not they could be saved: AES-128, multi-Period, live and
too-large streams were found out at click time, and "Best download" could choose one.

**Options.** (a) Hide what cannot be saved — the user never learns why the video on screen is
missing. (b) Show it and fail on click — the 0.1.5 behaviour. (c) Decide at scan time; show it
disabled, with the reason; skip it in "Best"; refuse it in the manager.

**Choice.** (c). Each candidate, and each rendition where it differs, carries a saveability: saveable,
or why not (DRM, encrypted, live, multi-Period, MediaSource only, too large, no rendition). It is
decided during the scan where possible — including one fetch of the best rendition's media playlist,
cached. A row's status is decided from the renditions "Best" chooses among (the video ones, when there
are any). The manager refuses the same statuses, so a stale popup cannot start one, and the download
itself still refuses a live or encrypted stream the scan could not decide.

**Why.** "Listed" must not mean "fails on click" for a reason that was knowable before the click; a
disabled row that says why is the honest middle.

**Trade-offs.** One extra request per scan for the probe, and its result is applied to the whole
ladder: on a mixed ladder (clear SD, protected HD) the probed rung speaks for all. A Referer-gated CDN
can leave a row undecided (D18).

## 3a. Download states and commands, in one place

The state machine (`core/download-types.ts` `ALLOWED_TRANSITIONS`, enforced by
`downloads/state-machine.ts`) is the only writer of a task's state; the manager asks it and never
assigns directly. What each user command does, by state and by engine:

| State | Pause | Resume | Cancel | Retry |
|---|---|---|---|---|
| QUEUED | → PAUSED (nothing running) | — | → CANCELLED | — |
| DOWNLOADING, direct file | the browser pauses its partial file → PAUSED | — | the browser cancels → CANCELLED | — |
| DOWNLOADING, segmented | not offered: the bytes are in memory, pausing would throw them away | — | aborts the fetch; a file already handed to the browser is taken back → CANCELLED | — |
| RESUMING | — | — | → CANCELLED | — |
| PAUSED, direct file | — | the browser continues from its partial file → DOWNLOADING | → CANCELLED | — |
| PAUSED, nothing started | — | → RESUMING, waits for a slot | → CANCELLED | — |
| VERIFYING (segmented, handed to the browser) | — | — | the browser cancels; the blob is released → CANCELLED | — |
| FAILED | — | — | → CANCELLED | → QUEUED, unless the task was recovered without its address (D16) |
| COMPLETED, CANCELLED | — | — | — | — |

What the browser does on its own is followed, not fought: a file finished in the browser → COMPLETED
(also from PAUSED, when it finished as the pause was requested); paused or resumed from the browser's
own download list → PAUSED / DOWNLOADING; cancelled there (on Firefox, an interruption that is not a
pause) → CANCELLED; interrupted for another reason → a retry if the reason is retryable and attempts
remain, else FAILED. A user stop is never reported as a failure: any error from an attempt the user
paused or cancelled is the consequence of that stop.

## 4. The DRM line

This is an architectural constraint, not a policy note.

- HLS: any `EXT-X-KEY` whose `KEYFORMAT` is not `identity`, and any `SAMPLE-AES*` method, sets
  `drm: true` and a system name.
- DASH: any `ContentProtection` descriptor, anywhere in the MPD, sets `drm: true`.
- One table names the systems for both formats (`manifests/drm-systems.ts`); an identifier it does not
  know still counts as protected.
- EME: MediaKeys actually attached to a player (`setMediaKeys` with keys, or `mediaKeys` on an element)
  sets `hasMediaKeys`. A `requestMediaKeySystemAccess` call does not: players and fingerprinting
  scripts use it only to ask what the browser supports, and 0.1.4 called clear videos "protected".
- A DRM candidate is scored −60, which puts it under the display threshold; the popup shows it greyed
  with "Protected content", and `DownloadManager.enqueue` throws `DRM_PROTECTED` before anything is
  fetched. `plan-builder` refuses again at download time.

Plain AES-128 with `KEYFORMAT=identity` is *not* a DRM system, but this build does not decrypt it
either: writing encrypted segments to disk produces an unplayable file, so it is refused with
`UNSUPPORTED_MANIFEST` and a message that says exactly that.

## 5. Muxing

Not implemented. Concatenated fMP4 segments (DASH, and HLS with `EXT-X-MAP`) produce a valid playable
file; concatenated MPEG-TS segments play in VLC and ffmpeg but are not an MP4. Combining a video-only
representation with an audio-only one requires a remuxer.

The options when it is built: ffmpeg.wasm in the offscreen document (~25 MB wasm, slow start, but
self-contained) or a native messaging host (fast, but a separate installer). The interfaces are already
shaped for it: `assembler.ts` is the only place that turns parts into a file, and `MediaVariant` already
carries the audio pairing (`pairAudioFor`) that a muxer would consume.

## 6. State and lifetimes

| State | Lives in | Dies when |
|---|---|---|
| last scan per tab (what the popup shows) | `storage.session` `scan:<tabId>` | replaced by the next scan; tab closes; browser session ends |
| page context per tab (all frames) | `storage.session` `ctx:<tabId>` | browser session ends, top frame navigates, or tab closes |
| network observations per tab | in-memory `Map` in the worker (capped at 300/tab) | worker restarts, a new top-level document is requested, the page changes route (cut at the route's start), or tab closes |
| manifest details (the ladder) | in-memory `ManifestCache` in the scanner | 30 s after the fetch, or worker restarts |
| download queue, with each task's candidate | `storage.session` `downloads:queue` (D16) | the task is removed; an extension update or reload; a browser restart |
| trace of unfinished tasks (no URLs) | `storage.local` `downloads:trace` (D16) | the task finishes, fails or is removed |
| Referer rules | the browser's session rules (D18) | the last task using the host settles; the next worker clears leftovers at start |
| offscreen document | the browser (Chrome) | no segmented download is fetching, assembling or being written (D16) |
| settings, history | `storage.local` | user clears them |

Nothing is synced. Nothing is uploaded.
