# MediaGrab — security

An extension with `downloads` permission that runs code near hostile pages is a high-value target. This
document states the trust boundaries, what crosses them, and what deliberately does not.

## 1. Threat model

| Adversary | Capability | What they want |
|---|---|---|
| A hostile web page | runs arbitrary JS in its own origin; controls the DOM, its titles, its URLs, and what it posts to `window` | to make MediaGrab write a file outside the downloads folder, exfiltrate data from other origins, or execute page-controlled code with extension privileges |
| A hostile CDN / man-in-the-middle | controls manifest and segment responses | to make the parsers crash, loop, or allocate without bound; to read the user's cookies for other origins |
| A malicious or compromised adapter | would run in the background worker | full extension privilege |
| A curious observer of network traffic | sees requests MediaGrab makes | to learn what the user is browsing |

Out of scope: a compromised browser, a compromised OS, and an attacker with local file access.

## 2. Trust boundaries

```
  page JS  ──postMessage──►  page hook (MAIN world)   ← same process as the page: NEVER trusted
     │                            │
     │                     window.postMessage
     ▼                            ▼
  page DOM ──read-only──►  content script (ISOLATED)  ← extension code, but reads hostile input
                                  │
                          runtime.sendMessage
                                  ▼
                       background worker              ← the privileged side
                                  │
                          downloads / storage / fetch
```

Rules that hold at every boundary:

1. **The page hook has no extension privileges.** It is a content script registered in the page's own
   (MAIN) world, has no access to `chrome.*`, and its only output channel is `window.postMessage` with
   the envelope defined in `src/core/hook-protocol.ts`. Since 0.1.5 it is not a web-accessible file, so
   a site cannot fetch it to learn that MediaGrab is installed.
2. **The content script validates before relaying.** `event.source === window`, an origin check and
   `parseHookMessage`; what it sends onwards is a list of *claims* (`ReportedCandidate`: an http(s) URL,
   a kind, where it was found, what the page says about it) — page objects are never forwarded.
3. **The worker validates again.** Every inbound message goes through `parseMessage`
   (`src/core/messages.ts`), which is an allowlist of message types with per-field type checks, string
   length caps and array size caps; a page claim is allow-listed field by field, and only http(s) URLs
   pass. The worker then builds the candidate itself (`src/detection/candidate.ts`), so a page cannot
   pre-set variants, a score or a DRM verdict. Anything else is dropped silently. It then checks the *sender*: a
   content script may only send `PAGE_REPORT` (a report about its own page); starting a download,
   commanding one or reloading settings is accepted only from the extension's own pages, identified by
   the browser-set sender URL (`src/background/message-router.ts`).
4. **No page string is ever evaluated.** No `eval`, no `new Function`, no `innerHTML` with page content,
   no dynamic `import()` of a page-supplied URL. The CSP is `script-src 'self'; object-src 'self'`.

## 3. Filenames — the highest-consequence path

`downloads.download({ filename })` writes to disk. Page titles reach that field, so
`src/media/naming.ts` is treated as a security boundary, not a formatting utility:

- path separators (`/`, `\`) and every character illegal on Windows or macOS are replaced with a space,
  by code-point test rather than a regex, so no control character appears in the source either;
- every dot run that begins a word is removed, so `..`, `.` and `.bashrc` cannot survive;
- Windows device names (`CON`, `LPT1`, …) are prefixed;
- each segment is capped at 120 UTF-8 bytes, cut only between code points, and the whole path at 200,
  truncating the file name's stem and never its extension or a folder;
- a segment that sanitizes to nothing becomes a fallback, never an empty string.

Unit tests assert that `../../../../Library/LaunchAgents/evil` as a page title produces a two-segment
path inside the download folder with no `..` anywhere.

## 4. What the network observer sees, and what it does not

`webRequest.onResponseStarted` is **observe-only**. It cannot block, redirect or modify a request, and
this build never registers a blocking listener. From each response it reads the URL, the status, the
type, and four headers: `Content-Type`, `Content-Length`, `Content-Range` (the whole file's size, when
the response is one range of it) and `Content-Disposition` (a link that downloads a file is not a new
page). It never reads a request header, a response body, or a cookie.

It only fires for hosts the user has granted. Media on another host (a CDN) is found from inside the
page instead: the page hook sees the page's own `fetch`/XHR calls, and the content script reads the
page's Resource Timing entries. Both see URLs the page itself requested, nothing more.

It is also **scoped**. On Chrome, `webRequest` is an optional permission granted together with the first
site grant, and the listener is registered for the granted origin patterns rather than `<all_urls>`. A
fresh install holds neither, so the observer sees nothing at all until the user says yes to a specific
site. This is enforced by tests that load the shipping build and assert the manifest declares no host
permissions and no static `webRequest`.

## 5. Credentials and what we send

Policy: ARCHITECTURE.md D18 (decided 2026-09-25).

- **Cookies: never added.** Every `fetch` MediaGrab makes — manifests, segments — passes
  `credentials: 'omit'`. Two reasons: a credentialed CORS request fails against the
  `Access-Control-Allow-Origin: *` most media CDNs send, and it would let a page's claims make
  MediaGrab send the user's cookies to any host. A direct file is different: it is fetched by the
  browser's own download manager (`downloads.download`), which sends the browser's cookies for that
  site as any download does; MediaGrab adds none and cannot remove them.
- **Referer: the page, where the user has allowed it.** `fetch` drops a scripted Referer (a forbidden
  header), so while a download runs, a *session* `declarativeNetRequest` rule sets `Referer` to the page the
  media was found on — and only:
  - on requests not tied to a tab (`tabIds: [-1]`): MediaGrab's own. A site's own service worker is
    not tied to a tab either, so while a task runs its requests to the same host carry the page too —
    to a host that already receives it from MediaGrab;
  - to the hosts that task fetches from (its manifest, init segment and segments, and a host that
    refused it after a redirect), and their subdomains (`requestDomains` matches those);
  - where MediaGrab holds host access: the permission is `declarativeNetRequestWithHostAccess`, so the
    browser ignores the rule for any host the user has not granted (and it adds no install warning);
  - until the last task using that host settles. Rules a killed worker leaves behind are cleared by
    the next worker at start, before it restores the queue; the browser clears session rules on
    restart. Scan-time manifest fetches carry no Referer (ARCHITECTURE.md D18 trade-offs).
  An extension test asserts what reaches the server: the page as Referer to a granted host, nothing to
  an ungranted one (`tests/extension/durability.spec.ts`, `extension.spec.ts`).
- **No other header** is set, except `Range` for byte-range segments.
- **When a site refuses**: a 403 from a host MediaGrab has no access to fails as `STREAM_EXPIRED`, and
  the row offers "Allow ‹host› and retry" — a normal per-host grant from the user's click. A 401 fails
  as `AUTH_REQUIRED`: that needs the user's session, which MediaGrab does not borrow; it does not bypass
  sign-in.

## 5b. The preview image

Each media row shows a poster, which means the popup — an extension page — loads a remote image.

- The image is one the page itself already loaded, so the CDN learns nothing it did not already know.
- It is requested with `referrerpolicy="no-referrer"`, so the request does not disclose that it came
  from the extension rather than from the page, and `loading="lazy"`, so a row that is never scrolled
  into view is never fetched.
- Only `http(s)` posters are used. `data:` URLs are rejected by `media/poster.ts`, because a data-URL
  poster is almost always a 1px placeholder and inlining page-controlled bytes into the popup is not a
  trade worth making.
- A poster is never downloaded to disk and never leaves the machine.
- The image is `aria-hidden` and decorative; the row's heading already names the media.

## 6. Parser hardening

Both parsers run on attacker-controlled input.

- **XML** (`dash/xml.ts`): DTD and ENTITY declarations are *rejected*, not skipped — no XXE surface. No
  external entity resolution exists. Unbalanced documents and multiple roots throw rather than being
  guessed at. Attribute scanning is quote-aware so a `>` inside a value cannot truncate a tag.
- **HLS** (`hls/attributes.ts`): the attribute tokenizer is quote-aware, so a comma inside `CODECS="…"`
  cannot desynchronise the parse.
- **Bounds**: manifests over 8 MB are refused; segment plans are capped at 20 000 segments; a
  `SegmentTemplate` with `@duration` and no period duration produces an empty plan rather than an
  unbounded loop; assembled downloads are capped at 1.5 GB.
- Both parsers are pure functions over strings, with no network and no DOM, and are fuzzed by the unit
  suite with malformed and hostile inputs.

## 7. Privacy

There is no backend. No page URL, no media URL and no media file leaves the machine.

- **There is no telemetry.** Not off by default — absent: there is no setting, no code path and nowhere
  to send it. (A `telemetry: false` placeholder setting existed until 0.1.4 and was removed because a
  switch that does nothing is a promise the product does not keep.)
- **The saved queue** (D16): `downloads:queue` in `storage.session` holds each task's media URLs,
  signed ones included, for the rest of the browser session — a failed row's too, until the user
  retries or cancels it. Session storage is in memory, never written to disk by the browser, cleared
  at restart and on an extension update, and not readable by content scripts (MediaGrab never widens
  its access level). What survives an update or restart, `downloads:trace` in `storage.local`, holds
  no URL; a test asserts it.
- **Diagnostics are clipboard-only.** "Report this site" builds a report locally, passes it through
  `redactDeep`, and copies it to the clipboard so the user reads exactly what they are about to share.
- **Redaction** (`src/core/redact.ts`) replaces query parameters matching token/sig/expires/auth/session
  patterns, replaces signature-shaped path segments (32+ opaque characters, JWTs, Akamai `hdnt*=`
  tokens, `name=value` segments), redacts URLs nested inside query values, strips credentials and
  fragments, reduces `blob:`/`data:` URLs to a placeholder, and replaces any object key that looks like
  a header (`cookie`, `authorization`, `referer`, …).
- **Logging**: debug lines appear only in debug mode; outside it, string payloads are redacted first.
- **History** stores no URL at all since 0.1.5 — only the file name, the site's domain and the time.
  A history entry holding a signed URL would be a credential sitting in storage.
- The user agent in a report is reduced to family and major version.

## 8. Supply chain

- Runtime dependencies: **none**. `package.json` has `devDependencies` only.
- No remote code is loaded at runtime. Adapters are bundled and reviewed; remote adapter delivery is
  deliberately not implemented (`ARCHITECTURE.md` D7).
- The icons are generated at build time by `scripts/icons.mjs` rather than committed as binaries.

## 9. Known weaknesses

Stated rather than hidden.

1. **The page hook patches `fetch`, `XHR`, `MediaSource`, `createObjectURL`, `setMediaKeys` and
   `history.pushState`/`replaceState` in the page's world.** It
   is written to be transparent (Proxy, originals preserved, failures isolated), but a page that
   inspects its own globals can detect it, and a bug there breaks the page rather than just detection.
2. **The Referer reaches only granted hosts.** A CDN that requires one and that the user has not
   allowed still refuses; the row offers the grant (§ 5). One rule per host carries the most recent
   page's URL, so two tabs downloading from one CDN at once share it.
3. **Any bundled adapter has full worker privilege.** The contract limits what an adapter *should* do;
   nothing sandboxes what it *can* do. That is the main reason remote adapters are not implemented.
4. **The offscreen document shares the extension's message bus.** It is now closed whenever no
   segmented download needs it (ARCHITECTURE.md D16), which also frees anything a killed worker left
   in it. Messages are
   namespaced with a `target` field, which is discipline rather than isolation.
5. **`storage.session` on Firefox versions without it** falls back to an in-memory map with the same
   lifetime, but that map is per-background-context and is lost on an event-page restart.
6. **No Subresource Integrity on media.** Segment content is not verified beyond HTTP status and length;
   manifests rarely publish checksums.

## 10. Reporting

This is a personal project with no security contact. If you are reading this because you found
something, open an issue in the repository with the details.
