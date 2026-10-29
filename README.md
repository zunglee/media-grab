# MediaGrab

A cross-browser extension that finds the downloadable audio and video on the page you are looking at,
shows you the real quality options, and downloads them.

It does **not** remove DRM, bypass paywalls, defeat sign-in, or circumvent any other access control.
That is a product decision, not a limitation to be worked around later — see [SECURITY.md](SECURITY.md)
and `ARCHITECTURE.md` § "The DRM line".

**Status: v0.1.6, pre-alpha.** Verified end to end in a real Chromium: the extension detects an HLS
ladder, a DASH manifest and a progressive file on a live page, filters the advert and the poster,
refuses DRM, and downloads all three kinds to disk with correct byte counts. What is *not* built is
listed in "Known limitations" below, and section 8 of [extensive.md](extensive.md) is the honest
per-feature ledger. Chromium is the target (`ARCHITECTURE.md` D19); the Firefox build is experimental and has never been run.

---

## Install it in Chrome

MediaGrab is not in the Chrome Web Store; you build it and load it as an unpacked extension.
You need [Node.js](https://nodejs.org) 22 or later and [pnpm](https://pnpm.io) 11
(`npm install -g pnpm`).

1. **Build it.**

   ```bash
   git clone https://github.com/zunglee/media-grab.git
   cd media-grab
   pnpm install
   pnpm build
   ```

   That writes two unpacked extensions: `dist/chrome` and `dist/firefox`.

2. **Load it.** Open `chrome://extensions`, switch on **Developer mode** (top right), press
   **Load unpacked**, and choose the `dist/chrome` folder. Optionally pin MediaGrab from the
   puzzle-piece menu in the toolbar.
3. **Use it.** On a page with a video, open the MediaGrab popup and press **Enable on this site**
   (MediaGrab ships with *no* host permissions and asks for one site at a time — see "Permissions"
   below). Reload the page once so MediaGrab sees its media requests from the start; the popup then
   lists what it found. **Best download** saves the best version; each row's own button saves that one.
4. **After pulling new code**, run `pnpm build` again and press the reload icon on MediaGrab's card in
   `chrome://extensions`.

| Browser | Load it with |
|---|---|
| Chrome / Edge / Brave / Opera | `chrome://extensions` (or `edge://extensions`, …) → Developer mode → **Load unpacked** → `dist/chrome` |
| Firefox (experimental, never run — `ARCHITECTURE.md` D19) | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `dist/firefox/manifest.json` |

Files are saved in your browser's download folder, under `MediaGrab/` (the folder name, a folder per
site or per date, and "Ask where to save every file" are on the options page).

### Develop the UI without reloading an extension

```bash
pnpm dev
```

`http://127.0.0.1:5177` renders the popup and the options page against fixtures (the popup runs its
real controller over a fixture bridge; the options page over an in-memory fake of the browser API).
This is also what the Playwright UI tests drive.

### Everything else

```bash
pnpm test        # 560 unit tests (Vitest)
pnpm test:e2e    # 72 Playwright tests: 27 UI (incl. axe) + 45 driving the real extension in a real
                 # Chromium (first run: `pnpm exec playwright install chromium`)
pnpm typecheck   # svelte-check + tsc
pnpm lint        # Biome
pnpm knip        # dead code and unused dependencies
```

---

## What it does

**Detection** runs five observers at once, because no single one is enough:

| Observer | Sees | Misses |
|---|---|---|
| DOM scan (content script) | `<video>`, `<audio>`, `<source>` (each with its own type), `<track>`, posters, `og:video`, JSON-LD `VideoObject`, media links — resolved against `<base href>` | anything the player never puts in the document |
| Page hook (MAIN world, installed before the page's own scripts) | `fetch`/`XHR` URLs, including extensionless manifests recognised by their Content-Type; `MediaSource` use; MediaKeys attached to a player (DRM); single-page-app route changes | request and response bodies (deliberately); players running in a Worker |
| Resource Timing (content script) | every URL the page fetched, on any host — preloads included | the type of an extensionless URL |
| Network observer (background) | every media response on a site you granted, with its type and size | other hosts (a CDN) — the two observers above cover those |
| Manifest expansion (background) | the full quality ladder inside an HLS master playlist or a DASH MPD | manifests behind credentials |

Stream segments (`.ts`, `.m4s`, numbered chunks) are recognised and never shown as downloads, and a
rendition or subtitle playlist that a master playlist already lists is shown inside it, not beside it.

**Intelligence** then normalizes, fingerprints, de-duplicates and scores what came back, so the popup
shows a handful of real options instead of thirty URLs. A thumbnail scores 6; a 4K HLS ladder scores 95.
Everything filtered out stays visible in Power mode with the reasons attached. Each row also gets a
preview image — inherited from the page when a network-found manifest has none of its own — falling back
to a labelled placeholder rather than a blank box.

**Downloads** take one of two routes:

- a direct file goes to the browser's own download engine, which gives it real resume, disk streaming
  and the download shelf for free;
- an HLS/DASH rendition is fetched segment by segment with bounded, adaptive concurrency, retries with
  jittered backoff, and `Retry-After` honoured, then assembled and handed to the browser as one file.

---

## Permissions

MediaGrab requests **no host permissions at install time**. `manifest.json` declares
`optional_host_permissions` only, and the popup asks for the current origin from a click, with the
origin visible on screen.

`webRequest` is optional too, and is requested in the same click. Chrome warns at install if an
extension declares `webRequest` with no host permissions — *"You need to request host permissions in
the manifest file in order to be notified about requests from the webRequest API"* — and it is right:
a `webRequest` listener with no host permission never fires. So MediaGrab declares neither up front and
asks for both at once.

The honest cost: the network observer can only see requests made *after* the grant, so the first time
you enable MediaGrab on a site you need to reload the page. The popup says so.

Firefox keeps `webRequest` as a static permission, because that build has never been run and this was
not the change to find that out with.

The static permissions it does request:

| Permission | Why |
|---|---|
| `storage` | settings and download history, local only |
| `downloads` | the actual saving of files |
| `tabs` | to know which page the popup is talking about |
| `activeTab`, `scripting` | to run detection in the tab you are on, when you ask |
| `webRequest` | **optional on Chrome** — requested together with your first site grant, because it does nothing without one |
| `contextMenus`, `notifications` | right-click actions, download-complete notice |
| `offscreen` (Chrome only) | an MV3 service worker has no `createObjectURL`; segment assembly needs one |
| `declarativeNetRequestWithHostAccess` (Chrome only) | names the page as Referer on MediaGrab's own requests, only to sites you have allowed (`ARCHITECTURE.md` D18); adds no install warning |

There is no `<all_urls>` content script, no remote code, no backend, and no analytics.

---

## Known limitations

These are real and current. Nothing here is stubbed to look finished.

1. **No muxing.** A DASH stream, or an HLS stream with its audio in a separate rendition, is saved as
   two files: "Best download" queues the best video and its paired audio (`ARCHITECTURE.md` D20).
   MediaGrab does not yet combine them into one file; a single video-only rendition picked by hand is
   marked "video only — no sound". Combining them needs a remuxer (ffmpeg.wasm or
   a native companion) — see `ARCHITECTURE.md` § "Muxing".
2. **No decryption.** AES-128-encrypted HLS is detected and refused with a clear message rather than
   producing an unplayable file. DRM (Widevine/PlayReady/FairPlay) is detected and always refused.
3. **Segment downloads assemble in memory**, so they are capped at 1.5 GB (and 20,000 segments — a
   longer stream is refused, never cut short) and cannot be paused, so the popup offers only Cancel for
   them. Direct files, and single-file DASH representations, pause and resume properly, because the
   browser does that work. Streaming to disk needs a native host.
4. **Live streams are detected but not captured.** The popup labels them; there is no recording mode.
5. **Multi-period DASH is refused.** Its first period's qualities are listed, but a download is refused
   rather than saving only the first part (usually an advert).
6. **No site adapters ship yet.** The adapter framework and registry exist and the generic adapter runs
   everywhere; no site-specific adapter is bundled, and remote adapter delivery is deliberately not
   implemented (`ARCHITECTURE.md` § "Adapter distribution").
7. **Chromium is the target; Firefox is experimental** (`ARCHITECTURE.md` D19). The Firefox build is
   produced from the same source but has never been run — Playwright cannot load extensions into
   Firefox — and it is not a release gate. [TESTING.md](TESTING.md) § 5 has the detail.
8. **i18n is started, not finished.** The manifest strings (name, description, command labels) come from
   `_locales/en/messages.json`. Every string inside the popup and options page is still inline English.
9. **Subtitles are detected and shown but not downloaded.** Posters are shown as the row preview but
   cannot be saved as files.
10. **The page is sent as Referer only to sites you have allowed** (`ARCHITECTURE.md` D18). A CDN you
    have not allowed that checks the Referer refuses; the failed row offers "Allow ‹host› and retry".
    MediaGrab never adds cookies, so a stream that needs you to be signed in fails as "requires
    sign-in". (A direct file is fetched by the browser's own download manager, which sends the
    browser's cookies for that site, as any download does.)
11. **After an extension update or a browser restart**, only downloads the browser itself still holds
    are picked up again; the rest stay listed as interrupted, without Retry, until removed, because MediaGrab keeps
    no address on disk (`ARCHITECTURE.md` D16). A worker restart loses no task; a segmented download
    caught mid-fetch is marked interrupted and starts again from zero on Retry.
12. **Route changes follow a rule, and a rule has edges** (`ARCHITECTURE.md` D17). Routes change by the
    History API, by a route-like hash (`#/video/2`, `#!/video/2`) and by the Navigation API; a plain
    anchor (`#comments`, `#t=90`) does not change the route. A bare `#video/2` (Backbone style) is read
    as an anchor. A `pushState` that only changes the query counts as a new route (on many sites
    that is the next video), so a player that stays on screen can drop out of the network observer's
    list (the page hook still holds its manifest). A placeholder link (`#`, `#!`) is not a route. A page prerendered and then shown can lose requests made between the switch and its
    first report.
13. **Some players are out of sight:** players inside `about:blank` or `srcdoc` iframes, and players
    that fetch from a Worker, are invisible to the page hook and to Resource Timing. On a page
    MediaGrab was injected into late (right after a grant), what the page fetched earlier is kept only
    when the page can show it has stayed on one route; otherwise detection starts at the grant, and a
    manifest fetched before it needs a reload (the popup says so).
14. **Segmented downloads show `.ts` until they start**: the playlist says whether the file is MPEG-TS
    or fMP4, and it is read when the download begins. A name the browser changes afterwards (to avoid
    a clash, or in the Save As dialog) is not reflected in the popup.
15. **A hostile page is held to a per-tab storage budget** (`core/limits.ts`), trimming its sub-frames'
    claims first; there is no budget across tabs, so very many hostile tabs could still fill the
    browser's session quota.

---

## Documents

| File | What is in it |
|---|---|
| [CONTEXT-RUNWAY.md](CONTEXT-RUNWAY.md) | all the context in one place — flows, state and durability, decisions, known gaps, open owner questions, and what to do next |
| [extensive.md](extensive.md) | the living spec; § 8 is the per-feature status ledger |
| [ARCHITECTURE.md](ARCHITECTURE.md) | module map, data flow, and the decisions with their trade-offs |
| [SECURITY.md](SECURITY.md) | threat model, trust boundaries, what never leaves the machine |
| [PERFORMANCE.md](PERFORMANCE.md) | budgets and how they are measured |
| [TESTING.md](TESTING.md) | what is tested, what is not, and why |
| [CHANGELOG.md](CHANGELOG.md) | Keep a Changelog |
| [design/IDENTITY.md](design/IDENTITY.md) | the visual and interaction language, and what was rejected |
