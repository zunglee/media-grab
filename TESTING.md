# MediaGrab — testing

```bash
pnpm test        # 560 unit tests, Vitest, node environment
pnpm test:e2e    # 72 Playwright tests (builds dist/chrome-test first)
pnpm typecheck   # svelte-check + tsc --noEmit
pnpm lint        # Biome
```

All four are green as of v0.1.6.

## 1. Strategy

Three layers, because they fail differently.

The architecture exists partly to make the first one possible: everything above `ScanResult` is pure and
runs in Node with no browser, no DOM and no network. That is where a mis-read byte range turns into a
file that plays for two seconds.

The second is the UI, driven against fixtures through the popup's bridge (the real `PopupController`
over `fixture-bridge.ts`). Fast, and where
the accessibility gates live.

The third is the extension itself, loaded into a real Chromium and pointed at a local fixture site. It
exists because the first two cannot catch integration bugs — and it immediately caught three, including
one that broke *every* HLS and DASH download on Chrome (§ 4).

| Layer | How it is tested | Why that way |
|---|---|---|
| HLS + DASH parsers | unit, against realistic manifests | pure functions, highest consequence of a bug |
| segment plan builders | unit, asserting exact URLs | an off-by-one here corrupts every download |
| fingerprint / dedupe / score / quality / naming | unit | pure, and the source of most product behaviour |
| download state machine, progress, segment fetcher | unit, with an injected `fetch` | concurrency and retry logic, no network needed |
| download manager (slots, pause/resume, retries) | unit, with fake engines and a fake browser | the queue's rules, without fetching a byte |
| worker detection flow (frame reports, per-tab ordering, scan coalescing, sender rules) | unit, against the in-memory browser fake | the races live here; a fake makes them deterministic |
| message validation, redaction, settings, permissions | unit | these are security boundaries |
| popup + options UI | Playwright against the fixture harness | real rendering, real interaction, real axe |
| the whole extension | Playwright against a real Chromium with `dist/chrome-test` loaded | the only place integration bugs show up |

## 2. Unit tests (560, 25 files)

`tests/unit/`

**`hls.test.ts` (25)** — attribute lists with commas inside quoted `CODECS`; byte ranges with and
without an offset; master vs media discrimination; variants with resolution, frame rate, codecs and
group ids; I-FRAME trick-play streams excluded; audio and subtitle renditions; `ENDLIST` absence meaning
live; AES-128 recorded as encrypted but *not* as DRM; Widevine key formats recorded as DRM; segment
URLs resolved against the playlist URL; rolling byte-range offsets (`#EXT-X-BYTERANGE` without `@`
continues from the previous sub-range).

**`dash.test.ts` (34)** — the XML reader (elements, attributes, CDATA, comments, namespace-insensitive
lookups, a `>` inside a quoted value, DOCTYPE **rejected**, unbalanced and multi-root documents
rejected, entity decoding); ISO 8601 durations including the forms that must be *refused* (years,
months); fractional frame rates; hierarchical `BaseURL`; representation metadata and size estimates;
Widevine `ContentProtection`; `$RepresentationID$` / `$Number%05d$` / `$Bandwidth$` / `$$` expansion;
fixed-duration enumeration (158 segments across a 630 s period, first and last URL asserted);
`SegmentTimeline` with `@r` repeats; `SegmentList` with `mediaRange`; and the case where there is not
enough information, which must produce an empty plan rather than a guess.

**`media.test.ts` (43)** — URL normalization (volatile params dropped, remaining sorted, default ports
and credentials stripped, `blob:`/`data:` untouched); fingerprint stability across signed URLs and
separation across renditions; size bucketing; dedupe collapsing three signed URLs into one and merging
as a *union* with the richer source winning and a measured size beating an estimated one; format
identification preferring MIME over extension; scoring (a 4K ladder above a thumbnail, ad paths
penalised, DRM pushed under the threshold, every point explained); the quality score preferring 1440p
with 192 kbps audio over 4K with 64 kbps; ladder de-duplication by rung; HLS audio-group pairing;
best/balanced/smallest recommendations; and the naming engine, including the traversal test.

**`downloads.test.ts` (30)** — state machine legality and refusal reasons; command mapping; HTTP status
→ error code; retryable vs terminal; `AbortError` classified as a cancellation; EWMA speed smoothing and
ETA; the segment fetcher returning parts **in playlist order regardless of completion order**, retrying
and succeeding, stopping at the first permanently failed segment, sending `Range` headers, never sending
credentials, aborting on signal, refusing an empty plan, and parsing `Retry-After` in both formats; and
the assembler refusing to write a file with holes in it.

**`core.test.ts` (34)** — message validation (unknown types dropped, malformed candidates filtered,
batch capped at 500, page titles truncated, `tabId` type-checked); redaction (token params, opaque path
segments, `blob:`/`data:`, credentials, header-shaped object keys); settings merge (missing fields
filled, unknown keys and wrong types ignored, values clamped, empty template rejected, settings from
older versions dropped);
history day grouping; the diagnosis ladder (DRM above everything, then MSE, then "press play", then
cross-origin frames); segment-URL recognition; and site access — which URLs yield an origin pattern
(`chrome://`, `file://` and unparseable URLs must not) and how a granted origin becomes a content-script
match pattern.

**`manager.test.ts` (33)** — the download manager driven through fake engines (it takes its engines as a
constructor argument for exactly this): every free slot filled and no more, a direct file handed to the
browser still holding its slot; pause and resume of a direct file delegated to the browser with no
second download; a file that finishes in the instant it is paused recorded as complete; pausing while
the manifest loads not restarting the task; retries for retryable errors only; a cancelled task staying
cancelled when the browser then reports it interrupted; a file handed over after a cancel taken back;
completion reported once; double requests joined; DRM refused before anything runs; a download paused
in the browser adopted by a new manager after a worker restart — as paused, as downloading if the user
resumed it from the browser meanwhile, or shown as interrupted if the browser no longer has it. Plus which rendition a download fetches ("best" is not "first listed"; a lone HLS media
playlist is its own rendition).

**`engines.test.ts` (3)** — the segmented engine, with planning and assembly mocked, never asks the
browser to save a file the user stopped after the last segment arrived; a stop while the Referer rule
is being set reaches neither the browser (no Save dialog) nor the offscreen document (re-audit).

Added in 0.1.5 (each regression test is named after the behaviour it pins, and was checked to fail
without its fix where the report says so):

**`detection.test.ts` (7)** — the page hook's message gate; the manifest cache (one fetch per
manifest while fresh, whatever its signature; failures not remembered; oldest forgotten); an expanded
master folding its renditions and subtitles but keeping its audio playlist as an audio row; a worker
restart leaving an unchanged content-script registration alone.

**`media-rules.test.ts` (78)** and **`redact-fetch.test.ts` (12)** — the media-rules audit (file names
that keep their extension within a byte cap, same-rendition identity, one resolution label, codec and
MIME tables, ranking, the ad-path rule, title cleaning) and redaction/fetch (Akamai and JWT path tokens,
nested URLs, short signature parameters, the 8 MiB streaming cap).

**`ui-popup-controller.test.ts` (21)**, **`ui-download-view.test.ts` (12)**, **`ui-site-access.test.ts`
(9)**, **`ui-badge.test.ts` (3)** — the popup's logic without a DOM: subscribe first, honest failed/no-tab
states, the reload notice after a grant, which buttons a row offers, the "~" estimate, the error's
headline and detail, Firefox's permission request (optional API permissions only).

**`storage-history.test.ts` (8)**, **`storage-settings.test.ts` (5)** — history with no URLs,
serialised writes and local calendar days (run in New York across both 2026 clock changes); settings
validated against their allowed values.

Added in 0.1.6 (the runway; ARCHITECTURE.md D16–D21):

**`durability.test.ts` (17)** — D16 through two managers standing in for an old and a new worker: a
worker restart loses no task (queued tasks run again; a download caught mid-fetch is "interrupted" with
Retry; a file the browser finished meanwhile is completed and reaches history; a running direct file is
followed, not restarted; the 0.1.5 paused-downloads key is read once); after an update or restart the
trace keeps no URL, a file the browser holds is followed by id without Retry, and a finished trace
clears itself; writes happen on state changes, not progress; the offscreen document closes at start and
when the last segmented download ends, never under one. From the re-audit: a task recovered from a
trace survives the next worker restart too; a failed row keeps its "Allow ‹host›" offer across one;
bringing the queue back never runs more downloads than the settings allow; a killed worker's offscreen
document is closed before the restore unless the browser is writing from it; from the verification
round, a retry after a worker restart still names the page to the host the row offered, and a failing
write is retried after a pause rather than on every change; and, from the reviewers' last check, a
change made just as a save finishes is still saved, whatever microtask it lands in. The fake storage stores
copies, as the browser does, so a lost write shows. Every restore rule and re-audit fix was reverted in
turn; a test failed each time.

**`referer-rules.test.ts` (11)** — D18: one Referer rule per host, shared between tasks and removed with
the last; a killed worker's rules cleared first — by the worker at start, before any download; nothing
for non-http pages or URLs; the manager holding rules until the file is complete; "Allow ‹host›"
offered only when a grant would help, including when only the other scheme is granted. From the
re-audit: a rule that arrives after its task settled is released at once; a retry names the page to a
host that refused after a redirect.

**`caps.test.ts` (11)**, **`assembly.test.ts` (11)** — the per-tab storage budget against a hostile
40-frame page (drop order to the byte, signals merged, the page's identity kept); segmented assembly
from blob parts with no byte arrays retained, order, the ceiling, cancel and failure, the refusing
host carried across the offscreen boundary, and a stop while the offscreen document is being made
never sending the stream to it (verification round).

**`navigation.test.ts` (57)** — D17 in the real hook and content script over a fake page that fires
events in the order the HTML standard gives: route-like hashes versus anchors, the Navigation API
de-duplicated against pushState, replace, back/forward, a broken Navigation API, back-forward-cache
restore, and the late-injection rule. 17 of them fail against the 0.1.5 hook.

**`best.test.ts` (28)**, **`saveability.test.ts` (32)** — D20's order (sound, resolution, bitrate,
score) on worst-first ladders, "4K video-only vs 1080p with sound", split streams getting both files,
too-large renditions skipped; D21 decided by the real engine against a fake network (AES-128, live,
multi-Period, too large, DRM not probed, the probe fetched once across scans, DASH segment counts equal
to the real plan's). From the re-audit: a row is judged by the renditions "best" can take (an audio-only
rung does not make a too-large ladder saveable); the programme's audio is paired, never an audio
description (DASH Role or DVB Accessibility, HLS `describes-video`), commentary or a louder dub; live
HLS and DASH are refused by the download too.

**`integration.test.ts` (3)** — the seams: the shortcut and menu queue video and audio as the popup
does; a separate audio track is an audio file; the manager refuses an unsaveable rendition.

**`background.test.ts` (33)** — the worker's detection flow: folding frame reports into tab state (only
the top frame names the page or triggers a navigation; a fragment change is not one; an iframe adds
media and DRM/MSE signals; a frame's report replaces its own earlier candidates); concurrent reports
from two frames both surviving; a closed tab never written back; one scan per tab in flight with one
shared follow-up, joined by a caller whose data it already includes; the router's sender rules; the
network observer starting a page at the document request, but not at an attachment, a file type the
browser cannot show, a 204 or a prerender, and keeping a prerendered page's media aside until it is
shown; manifest fetch errors classified (a caller abort is a
cancellation, never a retryable failure); and a segmented fetch stopping at the first hole.

## 3. UI tests (27)

`tests/e2e/popup.spec.ts`, driving `http://127.0.0.1:5177` — the fixture harness, which mounts the real
popup and options components; the popup runs the real `PopupController` over a fixture bridge.

Critical journeys covered:

1. detected media listed best-first with "Best download" as the primary action;
2. protected media shows the DRM explanation and offers **no** download button;
3. the quality ladder expands and lists exactly the four rungs;
4. an empty page shows the classified diagnosis (`MSE_ONLY`) and its remedies, not "no media found";
5. an in-flight download shows speed, ETA, segment count and an accurate `aria-valuenow`;
6. a failed download shows the *classified* message, not "download failed", and offers Retry;
7. no serious or critical axe violations in **light** mode;
8. no serious or critical axe violations in **dark** mode;
9. keyboard-only: first Tab lands on a button and the focus ring is visible;
10. the options page states the privacy position and the site-access model;
11. a row with a poster shows it, and the image actually decodes (`naturalWidth > 0`);
12. a row without one falls back to a labelled placeholder, not a blank box;
13. both are the same size, so the list does not reflow.

Added in 0.1.5: the reload notice survives the scan after a grant; a scan that did not finish says so
and offers "Scan again"; "Best download" is disabled, with the reason, when everything is protected; a
rendition without sound says so on its buttons; Pause is offered only where the browser keeps the
partial file; an estimated total reads "~"; every progress bar and row button has a name and the view
switcher is marked (with axe run on the Downloads view too); all-sites access is a status and a button,
not a checkbox; the options form shows the value that was saved.

Added in 0.1.6: unsaveable rows show their reason and no download button; an unsaveable rendition's
button is disabled with the reason as its description; a split stream says "video and audio as
separate files" and its Best download starts both; a download a host refused offers "Allow ‹host› and
retry", says the host refused, and asks for that host from the click (D18).

Tests 7 and 8 are gates, not reports. They found two real contrast failures during development: the
DRM row was dimmed with `opacity` to 3.1:1 (fixed by muting only the title), and dark-mode faint text
sat at 3.58:1 (fixed by raising `--ink-faint`).

## 4. Extension tests (45)

`tests/extension/`, driving a real Chromium via `chromium.launchPersistentContext` with the built
extension loaded, against a local fixture site (`fixture-site.ts`) that serves a video page with a
`<video>`+`<source>`, a poster, an ad bumper, an HLS master playlist with three renditions, a DASH MPD
with two video representations and an audio representation, and a Widevine-protected MPD. The player
script fetches both manifests at runtime, so only the page hook, Resource Timing and the network
observer can see them. A second host, `[::1]`, stands in for a CDN the test build holds no grant for.

It runs against `dist/chrome-test`: the shipping Chrome build plus two manifest changes — host
permissions for 127.0.0.1 and localhost, and the two content scripts (page hook in the MAIN world,
then the content script) declared instead of registered — because the browser's own permission prompt
cannot be scripted. Every line of the worker, engine, parsers and download manager under test is the
shipping code. `pnpm test:e2e` rebuilds it first so it can never be stale.

What it asserts:

1. the background worker boots;
2. an HLS master on a live page is detected **and expanded** into a 1080/720/480 ladder;
3. a DASH MPD is detected and expanded into its video representations;
4. the `<source>` file is detected and carries the page title;
5. the advert and the poster are scored below the display threshold and appear in `rejected`;
6. no diagnosis is reported when usable media was found;
7. a progressive download completes, with byte progress that agrees with the browser rather than sitting
   at zero, and the templated filename `MediaGrab/Deep Sea Documentary….mp4`;
8. an HLS rendition downloads by fetching and assembling its segments through the offscreen document,
   and the assembled size is exactly init + every segment;
9. a DASH representation downloads by enumerating `$Number%05d$` across the period, same size check;
10. two download requests issued in one turn collapse into one task;
11. DRM is detected and refused before a byte is fetched;
12. a stale candidate id is refused with an explanation;
13. media that only the DOM knows about (a `<video preload="none">` the page never fetches) is found;
14. a page with an embedded same-origin player keeps its own URL and title and holds both frames' media,
    after every frame's late pass has reported;
15. "Scan again" includes an element added a moment earlier, before the content script's own debounced
    report could fire — so the scan waited for a fresh report from the page;
16. a slowly served direct file is paused (the browser's own record says `paused: true`), resumed, and
    completes as the *same* browser download, with exactly one download of that URL;
17. after a fragment change (`#t=90`) on the page with the embedded player, "Scan again" still holds
    both frames' media.

Added in 0.1.5 — each fixture has exactly one way for its media to be found, so a detector that fails
cannot be covered for by another (the lesson of the 0.1.4 audit). All ten were run against the
untouched 0.1.4 build and fail there, each for the reason its bug predicts:

18. an extensionless manifest loaded by XHR from the ungranted CDN host is found (only the hook's
    response-type check can see it) and expanded;
19. a manifest only Resource Timing saw (a `<link rel="preload">` to the CDN host) is found;
20. stream segments and a rendition playlist the master already lists are never rows of their own;
21. URLs resolve against `<base href>`, and each `<source>` keeps its own type;
22. a MediaSource player gets the MSE explanation, not a `blob:` download;
23. a DRM capability probe on a page whose player has not started says "press play", not "protected";
24. a single-page app's pushState drops the old route's media and keeps the new route's manifest;
25. a `replaceState` tidying tracking parameters keeps the manifest fetched before it;
26. a single-file DASH representation downloads as a plain browser download, whole, once;
27. (in test 8) an HLS rendition whose playlist has `EXT-X-MAP` is saved as `.mp4`, not `.ts`.

Added in 0.1.6, in three spec files of their own. Run against the untouched 0.1.5 build, 12 of the 15
fail for the reason their bug predicts; the other 3 (a paused download across a worker stop, `#anchor`
clicks, a pushState reported once) guard behaviour 0.1.5 already had.

- `durability.spec.ts` (D16, D18): the page is named as Referer to a granted host (a hot-link-protected
  stream downloads); a refusing ungranted host is offered for a grant; a download paused in the browser
  survives the worker being stopped (DevTools `Target.closeTarget`, proved by a marker the old worker
  set); a file that finishes while no worker runs reaches history; after an update clears session
  storage, a paused download is followed by its id, without Retry, and the trace holds no URL.
- `navigation.spec.ts` (D17): a hash route and a hashbang route replace the old route's media;
  `#anchor` clicks keep it; an intercepted `navigation.navigate()` is a new route; a pushState the
  Navigation API also reports is one route change.
- `choice.spec.ts` (D20, D21): AES-128 and live streams listed as such before any click; the probe is
  cached; a too-large rendition is marked and a download without a pick takes the next; a split stream
  saves its best video and its audio as two files (this test found the offscreen creation race fixed in
  0.1.6).

A further test pins what actually reaches the server on a segment request: since 0.1.6 the page as
Referer, to this granted host (D18), and never a cookie. It exists so SECURITY.md cannot drift from the
truth.

Four more load the **shipping** `dist/chrome` build — the configuration `chrome-test` deliberately
cannot cover, because it is defined by the two permissions the test build adds. They assert it installs
with no host permissions and no `webRequest`, that `webRequest` is declared optional rather than static,
that the worker boots without complaining, and that the popup still gets an answer. That last one
mattered because `network.start()` used to run before the message-handler registration, so a throw there
would have produced a worker that never replies — a dead popup to the user. Since 0.1.4 the router is
registered first, and the test keeps it that way.

### What these tests found

- **`const doFetch = options.fetchImpl ?? fetch` detached `fetch` from its receiver.** A service worker
  tolerates that; a Window does not. Inside the offscreen document every segment threw
  `Failed to execute 'fetch' on 'Window': Illegal invocation`, so **every HLS and DASH download failed
  on Chrome**. Unit tests could not catch it — they always inject a `fetchImpl`. Now fixed at all three
  call sites, with a unit test that asserts the receiver is `globalThis`.
- **Direct downloads reported no progress.** `downloads.onChanged` reports state, not bytes, so the bar
  sat at 0% until the file finished. Now polled.
- **Failures were unclassified.** "5 of 5 segments could not be downloaded" with no reason — exactly the
  generic message this product exists to avoid. The first failure's code, message and URL now propagate
  from the offscreen document out to the task.
- **0.1.4: three flow bugs reproduced against 0.1.3 with the tests above** (13, 14, 16): DOM-only media
  was erased by a race between two messages from one scan; an iframe's report was treated as a
  navigation of the whole tab; and pausing a direct file never paused it, so Resume downloaded it again.
  The old fixture page hid the first: its `<video>` is also fetched, so the network observer saw it.
- **`webRequest` was declared but could never fire** (0.1.2, reported from a real install). Loading the
  shipping build with nothing granted produced no scan at all, confirming Chrome's install warning was
  accurate rather than cosmetic. `webRequest` is now optional and granted with the first site.

## 5. What is still not tested automatically, and the release checklist for it

Since 0.1.6 the worker-lifetime cases are automated (`tests/extension/durability.spec.ts`): the
service worker is stopped with the DevTools protocol's `Target.closeTarget` (the call Chrome's own
"test service worker termination" guide uses), and each test proves the new worker is not the old one
by a marker the old one set. An extension update is reproduced by what it does to MediaGrab's state —
session storage cleared, a new worker. What remains cannot be driven by Playwright, so it is a
checklist, run by hand on the release candidate in Chrome, before a release is called done.

**Release checklist (Chromium — the target, ARCHITECTURE.md D19)**

1. **Extension reload.** Start a direct download from a granted site, pause it, reload the extension
   from `chrome://extensions`, open the popup: the row is paused and has no Retry; Resume completes it
   as the same file. (Playwright cannot do this: `chrome.runtime.reload()` leaves an extension loaded
   from the command line blocked.)
2. **Prerender.** On a page with a Speculation Rules `prerender` list pointing at a video page,
   hover or wait until the target is prerendered (DevTools → Application → Preloading shows "Ready"),
   then open the popup on the source page: the target's media is not listed. Click through: the
   target's media is listed after the page reports. (Automated Chromium never prerenders, even with the
   Prerender2 feature forced.)
3. **Permission prompt.** On a site never granted, "Enable on this site" shows the browser's prompt
   naming that one site; after granting, the reload notice appears and a scan finds the page's media.
   On a download that failed with "Allow ‹host› and retry", the button shows the prompt for that host,
   and the retry succeeds on a CDN that checks the Referer.
4. **Late injection.** On a single-page app, move to a second route, then grant the site and press
   "Scan again": the first route's media is not listed. (The test build declares its scripts, so they
   are never injected late.)
5. **Assembly memory.** During a large HLS download, Chrome's Task Manager shows the offscreen
   document at about one times the file's size, not two, and the document disappears when the download
   finishes (ARCHITECTURE.md D16).

**Firefox (experimental, D19): not a release gate.** Build it, load `dist/firefox` with `about:debugging`,
and record in `extensive.md` § 8 what worked. Its differences (event page, in-place assembly, pause as
an interruption, `world: 'MAIN'` registration) are implemented from documentation and unit-tested
against fakes of that behaviour only.

**Still untested at the browser level:** live streams, multi-Period DASH, AES-128 HLS and byte-range HLS
are unit-tested at the parser level only; the assembly ceiling is a guard, not a measured limit.

## 6. Conventions

- A test asserts a *relation* where the exact number is judgement (scoring weights), and an exact value
  where correctness is exact (segment URLs, filenames, byte ranges).
- Network is never real. `fetchImpl` is injected.
- Fixtures are realistic manifests, not minimal ones, because minimal manifests do not contain the
  features that break parsers.
- A test that fails for the right reason is left failing until the code is fixed, not adjusted to pass.
  Of the five initial unit failures, three were code bugs (`$$` escape, size bucketing, dot stripping)
  and two were wrong expectations. Of the four failures in the first extension run, three were code bugs
  (detached `fetch`, missing progress, swallowed error reasons) and one was a wrong expectation (asserting
  on a file path that Playwright rewrites).
- The extension suite asserts through the extension's own state — `chrome.storage.session`, the task
  list, `chrome.downloads.search` — not the filesystem. Playwright intercepts extension downloads and
  renames them, so a file check would be testing Playwright.
