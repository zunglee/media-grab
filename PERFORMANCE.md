# MediaGrab — performance

A browser extension has a different performance shape from the web apps in this repository. Lighthouse
and LCP do not apply to a 384 px popup that is never navigated to. The budgets below replace the
CHARTER § 5 web budgets; the reasoning for each replacement is stated.

## 1. Budgets

| Metric | Budget | Measured (v0.1.6) | Why this budget |
|---|---|---|---|
| Popup JS, gzip | ≤ 60 KB | **30.2 KB** (popup.js 10.8 + shared chunk 14.9 + log 4.5) | the popup must paint before the user's hand leaves the mouse |
| Popup CSS, gzip | ≤ 15 KB | **2.7 KB** (popup.css 1.4 + shared 1.3) | it is one design-token file and five components |
| Options JS, gzip | ≤ 60 KB | **23.6 KB** | shares the same chunk as the popup |
| Background bundle, gzip | ≤ 40 KB | **37.7 KB** | an MV3 worker is re-parsed on every wake; size is latency on every event |
| Content script, gzip | ≤ 15 KB | **7.9 KB** | it runs on every page the user grants — the one bundle that is not "ours to spend" |
| Page hook, gzip | ≤ 3 KB | **2.7 KB** | it runs in the page's own context, before the page's own work |
| Total unpacked extension | ≤ 500 KB | **255 KB** | store review and install time |
| Popup time to first paint | < 100 ms | not yet instrumented | see § 4 |
| DOM scan, 2 000-node page | < 30 ms | not yet instrumented | see § 4 |
| Segment concurrency | 1–8, adaptive, default 4 | enforced in `segment-fetcher.ts` | a downloader that opens 20 connections gets the user rate-limited |

Replacements from CHARTER § 5, with reasons:

- **LCP / CLS / INP → popup time to first paint.** There is no page load and no scroll; the only latency
  the user feels is the popup opening.
- **Lighthouse perf/SEO → dropped.** A `chrome-extension://` popup has no SEO surface and Lighthouse
  cannot profile it meaningfully.
- **Lighthouse a11y → axe.** Accessibility is not dropped: `@axe-core/playwright` runs over the popup and
  options UI in both light and dark schemes, and zero serious/critical violations is a gate
  (see TESTING.md).

## 2. What the numbers are today

From `pnpm build`, each file gzipped at level 9. Every size in this document is in
KB of 1,024 bytes (KiB) — Vite's own build log prints kB of 1,000, so its figures read about 2% higher.

```
background.js     37.7 KB      content.js       7.9 KB
page-hook.js       2.7 KB      offscreen.js     2.4 KB
popup.js          10.8 KB      options.js       4.2 KB
shared chunk      14.9 KB      css (all)        3.2 KB
log chunk          4.5 KB
```

Zero runtime dependencies. Growth since 0.1.0 is the byte-progress poller, the tab-lifecycle cleanup
and the duplicate check (0.1.1), then in 0.1.4 +2.4 KB for per-tab report ordering, scan coalescing,
the sender check, in-browser pause/resume, carrying paused downloads across worker restarts and keeping
prerendered pages' traffic apart — all in the background bundle.

0.1.5 adds +5.4 KB to the background (the allow-list gate and candidate rebuild, the manifest cache,
the DASH parser's inheritance model and bigint timeline, interrupt-reason mapping, the retry module)
and +1.5 KB to the page hook, which now bundles `classifyMediaUrl` - the same "is this media, is it a
segment?" rule the rest of the extension uses - rather than a regex of its own. The hook is the bundle
closest to its budget; the next thing it needs should replace something, not add to it.

0.1.6 adds +3.2 KB to the background (the saved queue and its restore, the Referer rules, the
offscreen document's lifetime, saveability, and the re-audit's fixes to all four) and +0.2 KB to the
page hook (hash routes, the Navigation API, placeholder links). **Both are now the bundles closest to
their budgets: the background has 2.3 KB left, the page hook 0.3 KB.** The next feature in either should pay for itself by removing something; a
budget is not raised to make room.

The HLS probe (D21) adds one fetch per HLS master per scan, cached by `manifest-cache.ts`, so
repeated scans of the same page do not repeat it.

Two changes in 0.1.4 cut work rather than bytes: scans are coalesced to one per tab in flight (a page
that emits ten media requests used to start ten scans, each allowed eight manifest fetches), and a
segmented download stops at the first segment that fails for good instead of fetching the rest of a
file it will refuse to save.

## 3. Where the time actually goes

The bundle is not the interesting part. Three hot paths matter:

**Detection on a busy page.** The content script debounces DOM rescans by 700 ms and only reacts to
mutations that add a media-capable element. Every observer - page hook, Resource Timing, network -
drops segment-shaped URLs as soon as `classifyMediaUrl` has looked at them, before any candidate or
fingerprint exists, which is what keeps a page emitting 3 000 segment requests from doing 3 000
fingerprints (and the page hook from filling its memory with them). Caps: 300 network candidates per
tab; 200 claims per frame and 1 000 per tab from content scripts; all in `core/limits.ts`. A scan
reuses a manifest fetched in the last 30 s instead of fetching it again (`detection/manifest-cache.ts`).

**Fingerprinting.** It runs on every observed candidate, so it must be synchronous — `crypto.subtle` is
async, which is why the hash is FNV-1a. It is used for grouping, never for security.

**Segment downloads.** Concurrency starts at the user's "parallel segments" setting (default 4, at most
8), halves on a 429 or 5xx, and grows back by one per 8 clean segments - never above that setting.
Retries use full-jitter exponential backoff capped at 15 s (`downloads/retry.ts`), honour
`Retry-After`, and skip failures that cannot pass (401/403/404/410/416). Each segment is kept as a Blob part
and the file is composed from them by reference (0.1.6), so the peak is one copy of the file plus the
segments in flight. The
worker pool writes into a fixed-size array by index, so ordering costs nothing and a slow segment does
not reorder the file.

## 4. Not yet measured

Stated rather than implied:

- **Popup time to first paint** has no instrumentation. It needs a `performance.mark` in `popup/main.ts`
  and a way to read it from a real profile. The extension test suite now gives somewhere to read it from.

- **Detection latency** is now observable but unmeasured: the extension tests wait for a scan to appear
  in session storage, and typically see one within a second of load.
- **DOM scan cost on a large page** has no benchmark. `scanDom` is pure enough to benchmark in isolation
  with a synthetic document, which is the obvious next step.
- **Memory during a large segmented download** is bounded by the 1.5 GB assembly cap but has not been
  profiled. The cap is a guard, not a measurement.
- **Background worker wake latency** is not measured.

None of these blocks the current build; all of them belong in the first performance pass.
