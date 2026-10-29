/**
 * A local site that looks enough like a real video page to exercise the whole
 * detection pipeline: a `<video>` with a `<source>`, a poster, a player script
 * that fetches an HLS master playlist at runtime (so the page hook and the
 * network observer both have something to see), an ad bumper and a thumbnail
 * that the scoring layer is expected to reject.
 *
 * Served over plain HTTP on 127.0.0.1 because that is what the test build's
 * host permissions cover.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureSite {
  origin: string;
  /**
   * A second host, `[::1]`, standing in for a CDN. The test build grants
   * 127.0.0.1 and localhost only, so the network observer cannot see this
   * host: whatever is found on it was found from inside the page.
   */
  cdnOrigin: string;
  close(): Promise<void>;
  /** Every request the site saw, so a test can assert on replayed headers. */
  requests: Array<{ path: string; referer: string | undefined }>;
  /** Byte sizes of the things a test asserts on. */
  sizes: {
    featureMp4: number;
    slowMp4: number;
    hlsInit: number;
    hlsSegment: number;
    hlsSegments: number;
    dashInit: number;
    dashSegment: number;
    dashSegments: number;
    onDemandMp4: number;
    /** Segments in each rendition of the /choice/large stream (choice.spec.ts). */
    choiceLargeSegments: number;
  };
}

const FEATURE_MP4_BYTES = 2_100_000;
const HLS_INIT_BYTES = 1_200;
const HLS_SEGMENT_BYTES = 300_000;
const HLS_SEGMENT_COUNT = 4;
const DASH_INIT_BYTES = 900;
const DASH_SEGMENT_BYTES = 250_000;
/** 24 s period at 4 s per segment. */
const DASH_SEGMENT_COUNT = 6;
const DASH_PERIOD_SECONDS = 24;

/** Deterministic filler; the bytes never need to be decodable, only counted. */
function filler(size: number, seed: number): Buffer {
  const buffer = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i += 1) buffer[i] = (i * 31 + seed) & 0xff;
  return buffer;
}

/** Streamed slowly (see `sendSlowly`) so a test can pause it mid-flight. */
const SLOW_MP4_BYTES = 1_600_000;
const SLOW_CHUNK_BYTES = 40_000;
const SLOW_CHUNK_EVERY_MS = 100;

const FEATURE = filler(FEATURE_MP4_BYTES, 1);
const SLOW = filler(SLOW_MP4_BYTES, 5);
const EMBEDDED = filler(700_000, 6);
const HLS_INIT = filler(HLS_INIT_BYTES, 2);
const HLS_SEGMENTS = Array.from({ length: HLS_SEGMENT_COUNT }, (_unused, i) =>
  filler(HLS_SEGMENT_BYTES, 10 + i),
);
const DASH_INIT = filler(DASH_INIT_BYTES, 20);
const DASH_SEGMENTS = Array.from({ length: DASH_SEGMENT_COUNT }, (_unused, i) =>
  filler(DASH_SEGMENT_BYTES, 30 + i),
);
const POSTER = filler(9_000, 3);
const ON_DEMAND_MP4_BYTES = 800_000;
const ON_DEMAND = filler(ON_DEMAND_MP4_BYTES, 40);
const AD = filler(40_000, 4);

function page(origin: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Deep Sea Documentary | Fixture TV</title>
    <meta property="og:video" content="${origin}/media/feature.mp4" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "VideoObject",
        "name": "Deep Sea Documentary",
        "contentUrl": "${origin}/media/feature.mp4",
        "thumbnailUrl": "${origin}/media/thumbs/poster.jpg",
        "duration": "PT30M"
      }
    </script>
  </head>
  <body>
    <h1>Deep Sea Documentary</h1>
    <video id="player" controls poster="/media/thumbs/poster.jpg" width="640">
      <source src="/media/feature.mp4" type="video/mp4" />
    </video>
    <video id="bumper" src="/ads/preroll.mp4" muted></video>
    <script>
      // A real player fetches its manifest from script, never from the DOM.
      // This is the path only the page hook and the network observer can see.
      window.addEventListener('load', () => {
        fetch('/media/master.m3u8').then((response) => response.text());
        fetch('/media/manifest.mpd').then((response) => response.text());
        fetch('/media/protected.mpd').then((response) => response.text());
      });
    </script>
  </body>
</html>`;
}

/**
 * A page whose player lives in a same-origin iframe, next to a video of its
 * own. Both frames run the content script; only the top one is the page.
 */
function framedPage(): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Framed Feature | Fixture TV</title></head>
  <body>
    <video controls width="640"><source src="/media/feature.mp4" type="video/mp4" /></video>
    <iframe src="/embed" width="640" height="360" title="Embedded player"></iframe>
  </body>
</html>`;
}

function embedPage(): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Embedded Player</title></head>
  <body><video controls title="Embedded clip" src="/media/embedded.mp4"></video></body>
</html>`;
}

function slowPage(): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Slow Feature | Fixture TV</title></head>
  <body><video controls preload="none" src="/media/slow.mp4" title="Slow feature"></video></body>
</html>`;
}

/** Pass 2 fixtures: each page has exactly one way for its media to be found. */
const html = (title: string, body: string, head = '') => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${title}</title>${head}</head>
  <body>${body}</body>
</html>`;

const PASS2_PAGES: Record<string, (origin: string, cdn: string) => string> = {
  // hls.js-style: XHR to a manifest URL with no extension, on a host with no
  // grant. Only the page hook's XHR path, reading the response type, finds it.
  '/cdn-xhr': (_origin, cdn) =>
    html(
      'CDN player | Fixture TV',
      `<script>
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '${cdn}/cdn/stream');
        xhr.send();
      </script>`,
    ),
  // A preload link: fetched by the browser, not by page script, from a host
  // with no grant. Only Resource Timing lists it.
  '/preload': (_origin, cdn) =>
    html(
      'Preloaded | Fixture TV',
      '',
      `<link rel="preload" as="fetch" crossorigin href="${cdn}/cdn/preloaded.m3u8" />`,
    ),
  // A player that fetches its segments itself: none of them is a download.
  '/segments': () =>
    html(
      'Segments | Fixture TV',
      `<script>
        fetch('/media/master.m3u8').then((r) => r.text());
        for (const n of [0, 1, 2]) fetch('/media/1080/seg-' + n + '.ts').then((r) => r.text());
        fetch('/media/720/index.m3u8').then((r) => r.text());
      </script>`,
    ),
  // <base href> and one <video> offering two containers.
  '/base/page': () =>
    html(
      'Base href | Fixture TV',
      `<video preload="none" src="clip.mp4" title="Based clip"></video>
       <video preload="none" title="Two formats">
         <source src="alt.webm" type="video/webm" />
         <source src="alt.mp4" type="video/mp4" />
       </video>`,
      '<base href="/assets/" />',
    ),
  // MediaSource playback: the only URL on the page is a blob:.
  '/mse': () =>
    html(
      'MSE player | Fixture TV',
      `<video id="v"></video>
       <script>
         const ms = new MediaSource();
         document.getElementById('v').src = URL.createObjectURL(ms);
         ms.addEventListener('sourceopen', () => ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E"'));
       </script>`,
    ),
  // A capability probe, as players and fingerprinting scripts make - late, so
  // any version of the hook is installed by then. A player that has not
  // started, and no media yet: what the page needs is "press play", not DRM.
  '/probe': () =>
    html(
      'Probe | Fixture TV',
      `<video title="Clear clip"></video>
       <script>
         setTimeout(() => {
           navigator.requestMediaKeySystemAccess?.('org.w3.clearkey', [
             { videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] },
           ]).catch(() => undefined);
           document.body.append(document.createElement('div')); // nothing else changes
         }, 1500);
       </script>`,
    ),
  // A single-page app: route one plays one manifest, then pushState moves to
  // route two, whose player fetches another straight away.
  '/spa': () =>
    html(
      'SPA | Fixture TV',
      `<video id="old" preload="none" src="/media/old-route.mp4" title="Old route"></video>
       <script>
         fetch('/media/master.m3u8').then((r) => r.text());
         setTimeout(() => {
           history.pushState({}, '', '/spa/next');
           document.getElementById('old').remove();
           fetch('/media/manifest.mpd').then((r) => r.text());
         }, 3000);
       </script>`,
    ),
  // Tracking parameters tidied away with replaceState after the player started.
  '/tidy': () =>
    html(
      'Tidy | Fixture TV',
      `<script>
         fetch('/media/master.m3u8').then((r) => r.text());
         setTimeout(() => history.replaceState({}, '', '/tidy'), 1500);
       </script>`,
    ),
  // DASH on-demand profile: one self-contained MP4 per representation.
  '/ondemand': () =>
    html(
      'On demand | Fixture TV',
      `<script>fetch('/media/ondemand.mpd').then((r) => r.text());</script>`,
    ),
};

/**
 * D17 fixtures (navigation.spec.ts): single-page apps whose routes change by
 * hash and by the Navigation API. Each route's player fetches its own manifest
 * from the host with no grant, so the network observer never sees it: only the
 * page hook and Resource Timing do, and they are what must know which route a
 * request belongs to.
 */
const D17_PAGES: Record<string, (origin: string, cdn: string) => string> = {
  // A hash router. `#/...` and `#!/...` are routes; anything else after the
  // '#' is left alone, as routers leave anchors. The first route is set with
  // replaceState, which tidies the address and is no route change.
  '/hash': (_origin, cdn) =>
    html(
      'Hash app | Fixture TV',
      `<nav>
         <a id="to-video-2" href="#/video/2">Video 2</a>
         <a id="to-video-3" href="#!/video/3">Video 3</a>
         <a id="to-comments" href="#comments">Comments</a>
       </nav>
       <main id="view"></main>
       <section id="comments" style="margin-top: 150vh">Comments</section>
       <script>
         const routes = {
           '#/video/1': '${cdn}/cdn/route/hash-one.m3u8',
           '#/video/2': '${cdn}/cdn/route/hash-two.m3u8',
           '#!/video/3': '${cdn}/cdn/route/hash-three.m3u8',
         };
         function render() {
           const manifest = routes[location.hash];
           if (!manifest) return;
           document.getElementById('view').textContent = 'Playing ' + location.hash;
           fetch(manifest).then((r) => r.text());
         }
         window.addEventListener('hashchange', render);
         if (!location.hash) history.replaceState(null, '', '#/video/1');
         render();
       </script>`,
    ),
  // A router built on the Navigation API: it intercepts the navigations it
  // starts and loads the route's player inside the handler, so the manifest is
  // fetched after the address changed and before the navigation succeeds - a
  // second "new route" at that point would throw it away. The same app has
  // plain History API links too (pushRoute): in Chromium one pushState also
  // fires the Navigation API's events.
  '/navapi': (_origin, cdn) =>
    html(
      'Navigation API app | Fixture TV',
      `<main id="view">Route one</main>
       <script>
         const manifestFor = (path) => '${cdn}/cdn/route/navapi-' + path.split('/').pop() + '.m3u8';
         navigation.addEventListener('navigate', (event) => {
           if (event.info !== 'router' || !event.canIntercept) return;
           const path = new URL(event.destination.url).pathname;
           event.intercept({
             async handler() {
               await fetch(manifestFor(path)).then((r) => r.text());
               document.getElementById('view').textContent = 'Route ' + path;
             },
           });
         });
         window.pushRoute = (path) => {
           history.pushState({}, '', path);
           fetch(manifestFor(path)).then((r) => r.text());
         };
         fetch(manifestFor('/navapi/one')).then((r) => r.text());
       </script>`,
    ),
};

/**
 * D20/D21 fixtures (choice.spec.ts): streams whose saveability, and whose
 * "best", the scan decides. Each page's player fetches one master playlist and
 * nothing else, so every rendition playlist the site serves was asked for by
 * MediaGrab - the scan's one probe of the best rendition, or a download - and
 * a test can count them.
 *
 *   encrypted  segments under AES-128 (not DRM, but not saved either)
 *   live       no end list: still being written
 *   large      a 4K rung far above the in-memory assembly ceiling, and a 360p
 *              rung well under it: 100 minutes in ten 10-minute segments
 *   split      video-only renditions and a separate audio playlist
 */
const CHOICE_LARGE_SEGMENTS = 10;
const CHOICE_LARGE_SEGMENT_SECONDS = 600;
const HLS_TYPE = 'application/vnd.apple.mpegurl';

function choiceMaster(stream: string): string {
  if (stream === 'large') {
    return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=40000000,RESOLUTION=3840x2160,CODECS="hvc1.1.6.L150,mp4a.40.2"
2160/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360/index.m3u8
`;
  }
  if (stream === 'split') {
    return `#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3100000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac"
720/index.m3u8
`;
  }
  return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720/index.m3u8
`;
}

function choiceMedia(stream: string): string {
  if (stream === 'split') return mediaPlaylist();
  if (stream === 'large') {
    const segments = Array.from(
      { length: CHOICE_LARGE_SEGMENTS },
      (_unused, i) => `#EXTINF:${CHOICE_LARGE_SEGMENT_SECONDS}.000,\nseg-${i}.m4s`,
    ).join('\n');
    return `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:${CHOICE_LARGE_SEGMENT_SECONDS}
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
${segments}
#EXT-X-ENDLIST
`;
  }
  const segments = HLS_SEGMENTS.map((_unused, i) => `#EXTINF:6.000,\nseg-${i}.ts`).join('\n');
  if (stream === 'live') {
    return `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:120
${segments}
`;
  }
  return `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001
${segments}
#EXT-X-ENDLIST
`;
}

/** Everything under /choice/, or undefined for any other path. */
function choiceRoute(path: string): { type: string; body: string | Buffer } | undefined {
  const page = /^\/choice\/(encrypted|live|large|split)$/.exec(path)?.[1];
  if (page) {
    return {
      type: 'text/html; charset=utf-8',
      body: html(
        `Choice ${page} | Fixture TV`,
        `<video controls width="640"></video>
         <script>fetch('/choice/${page}/master.m3u8').then((r) => r.text());</script>`,
      ),
    };
  }
  const master = /^\/choice\/(encrypted|live|large|split)\/master\.m3u8$/.exec(path)?.[1];
  if (master) return { type: HLS_TYPE, body: choiceMaster(master) };
  const media = /^\/choice\/(encrypted|live|large|split)\/\w+\/index\.m3u8$/.exec(path)?.[1];
  if (media) return { type: HLS_TYPE, body: choiceMedia(media) };
  // Only the large stream's 360p rung and the split stream are ever downloaded.
  if (/^\/choice\/(?:large|split)\/\w+\/init\.mp4$/.test(path)) {
    return { type: 'video/mp4', body: HLS_INIT };
  }
  const segment = /^\/choice\/(?:large|split)\/\w+\/seg-(\d+)\.m4s$/.exec(path)?.[1];
  if (segment !== undefined) {
    const body = HLS_SEGMENTS[Number(segment) % HLS_SEGMENT_COUNT];
    return body ? { type: 'video/mp4', body } : undefined;
  }
  return undefined;
}

function onDemandManifest(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT20S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period id="p0" duration="PT20S">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4">
      <Representation id="v720" bandwidth="320000" width="1280" height="720" codecs="avc1.4d401f">
        <BaseURL>ondemand/video_720.mp4</BaseURL>
        <SegmentBase indexRange="700-799"><Initialization range="0-699"/></SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
`;
}

function masterPlaylist(): string {
  return `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5200000,AVERAGE-BANDWIDTH=4800000,RESOLUTION=1920x1080,FRAME-RATE=30,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3100000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac"
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aac"
480/index.m3u8
`;
}

/** A page whose player fetches one media playlist (no master) from `playlistUrl`. */
function hotlinkPage(playlistUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Protected Stream | Fixture TV</title></head>
  <body>
    <video controls width="640"></video>
    <script>fetch(${JSON.stringify(playlistUrl)}).then((response) => response.text());</script>
  </body>
</html>`;
}

function mediaPlaylist(): string {
  const segments = HLS_SEGMENTS.map((_unused, i) => `#EXTINF:6.000,\nseg-${i}.m4s`).join('\n');
  return `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
${segments}
#EXT-X-ENDLIST
`;
}

/**
 * Live-profile MPD: SegmentTemplate with a fixed @duration and zero-padded
 * $Number$, which is the addressing mode most real DASH streams use. Video and
 * audio are separate representations, as they are in the wild.
 */
function dashManifest(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT${DASH_PERIOD_SECONDS}S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <BaseURL>dash/</BaseURL>
  <Period id="p0" duration="PT${DASH_PERIOD_SECONDS}S">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate media="$RepresentationID$/seg-$Number%05d$.m4s" initialization="$RepresentationID$/init.mp4" timescale="1000" duration="4000" startNumber="1"/>
      <Representation id="v1080" bandwidth="4800000" width="1920" height="1080" frameRate="30" codecs="avc1.640028"/>
      <Representation id="v720" bandwidth="2400000" width="1280" height="720" frameRate="30" codecs="avc1.4d401f"/>
    </AdaptationSet>
    <AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" lang="en">
      <SegmentTemplate media="$RepresentationID$/seg-$Number%05d$.m4s" initialization="$RepresentationID$/init.mp4" timescale="1000" duration="4000" startNumber="1"/>
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
`;
}

/** Widevine-protected MPD. MediaGrab must detect this and refuse it outright. */
function protectedDashManifest(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT${DASH_PERIOD_SECONDS}S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <BaseURL>dash/</BaseURL>
  <Period id="p0" duration="PT${DASH_PERIOD_SECONDS}S">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" value="Widevine"/>
      <SegmentTemplate media="$RepresentationID$/seg-$Number%05d$.m4s" initialization="$RepresentationID$/init.mp4" timescale="1000" duration="4000" startNumber="1"/>
      <Representation id="v1080" bandwidth="4800000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
  </Period>
</MPD>
`;
}

/** The "CDN": manifests on a host with no grant, served with open CORS as real CDNs do. */
async function startCdn(siteOrigin: () => string): Promise<Server> {
  const cdn = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://[::1]').pathname;
    const reply = (type: string, body: string) => {
      response.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' });
      response.end(body);
    };
    // Segments stay on the site, so only the manifest is on the CDN host.
    const master = masterPlaylist().replace(
      /^(\d+)\/index\.m3u8$/gm,
      `${siteOrigin()}/media/$1/index.m3u8`,
    );
    if (path === '/cdn/stream') return reply('application/vnd.apple.mpegurl', master);
    // D18: segments refuse a request that does not name a page. MediaGrab has no
    // grant for this host, so it cannot name one: the download must fail with
    // an offer to allow the host.
    if (path === '/cdn/hotlink/index.m3u8')
      return reply('application/vnd.apple.mpegurl', mediaPlaylist());
    if (path.startsWith('/cdn/hotlink/')) {
      response.writeHead(request.headers.referer ? 200 : 403, {
        'access-control-allow-origin': '*',
      });
      response.end(request.headers.referer ? filler(HLS_SEGMENT_BYTES, 77) : 'name the page');
      return;
    }
    if (path === '/cdn/preloaded.m3u8') return reply('application/vnd.apple.mpegurl', master);
    // D17: one manifest per single-page-app route (D17_PAGES).
    if (/^\/cdn\/route\/[\w-]+\.m3u8$/.test(path))
      return reply('application/vnd.apple.mpegurl', master);
    response.writeHead(404, { 'access-control-allow-origin': '*' });
    response.end();
  });
  await new Promise<void>((resolve) => cdn.listen(0, '::1', resolve));
  return cdn;
}

export async function startFixtureSite(): Promise<FixtureSite> {
  const seen: Array<{ path: string; referer: string | undefined }> = [];
  let siteOrigin = '';
  const cdn = await startCdn(() => siteOrigin);
  const cdnOrigin = `http://[::1]:${(cdn.address() as AddressInfo).port}`;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = (status: number, type: string, body: string | Buffer) => {
      response.writeHead(status, {
        'content-type': type,
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      response.end(body);
    };

    /** Trickle a body out, honouring `Range: bytes=N-` so a paused download can resume. */
    const sendSlowly = (body: Buffer) => {
      const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');
      const start = range ? Number(range[1]) : 0;
      const rest = body.subarray(start);
      response.writeHead(range ? 206 : 200, {
        'content-type': 'video/mp4',
        'content-length': rest.length,
        'accept-ranges': 'bytes',
        ...(range ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
        'cache-control': 'no-store',
      });
      let offset = 0;
      const timer = setInterval(() => {
        if (response.destroyed) return clearInterval(timer);
        response.write(rest.subarray(offset, offset + SLOW_CHUNK_BYTES));
        offset += SLOW_CHUNK_BYTES;
        if (offset >= rest.length) {
          clearInterval(timer);
          response.end();
        }
      }, SLOW_CHUNK_EVERY_MS);
      request.on('close', () => clearInterval(timer));
    };

    const path = url.pathname;
    seen.push({ path, referer: request.headers.referer });

    const pass2 = PASS2_PAGES[path] ?? D17_PAGES[path];
    if (pass2) return send(200, 'text/html; charset=utf-8', pass2(origin, cdnOrigin));
    if (path === '/media/ondemand.mpd')
      return send(200, 'application/dash+xml', onDemandManifest());
    if (path === '/media/ondemand/video_720.mp4') return send(200, 'video/mp4', ON_DEMAND);

    // D18: a stream whose init and segments are refused unless the request
    // names the page it was found on - the usual CDN hot-link protection.
    if (path === '/hotlink')
      return send(200, 'text/html; charset=utf-8', hotlinkPage('/hotlink/index.m3u8'));
    if (path === '/hotlink-cdn')
      return send(
        200,
        'text/html; charset=utf-8',
        hotlinkPage(`${cdnOrigin}/cdn/hotlink/index.m3u8`),
      );
    if (path === '/hotlink/index.m3u8')
      return send(200, 'application/vnd.apple.mpegurl', mediaPlaylist());
    if (path.startsWith('/hotlink/')) {
      if (!request.headers.referer?.startsWith(`${origin}/hotlink`))
        return send(403, 'text/plain', 'name the page');
      const index = /seg-(\d+)\.m4s$/.exec(path)?.[1];
      return send(
        200,
        'video/mp4',
        index === undefined ? HLS_INIT : (HLS_SEGMENTS[Number(index)] ?? HLS_INIT),
      );
    }

    const choice = choiceRoute(path);
    if (choice) return send(200, choice.type, choice.body);

    if (path === '/framed') return send(200, 'text/html; charset=utf-8', framedPage());
    if (path === '/embed') return send(200, 'text/html; charset=utf-8', embedPage());
    if (path === '/slow') return send(200, 'text/html; charset=utf-8', slowPage());
    if (path === '/media/embedded.mp4') return send(200, 'video/mp4', EMBEDDED);
    if (path === '/media/slow.mp4') return sendSlowly(SLOW);

    if (path === '/' || path === '/watch')
      return send(200, 'text/html; charset=utf-8', page(origin));
    if (path === '/media/feature.mp4') return send(200, 'video/mp4', FEATURE);
    if (path === '/ads/preroll.mp4') return send(200, 'video/mp4', AD);
    if (path === '/media/thumbs/poster.jpg') return send(200, 'image/jpeg', POSTER);
    if (path === '/media/master.m3u8')
      return send(200, 'application/vnd.apple.mpegurl', masterPlaylist());

    const media = /^\/media\/(1080|720|480)\/index\.m3u8$/.exec(path);
    if (media) return send(200, 'application/vnd.apple.mpegurl', mediaPlaylist());

    if (path === '/media/audio/en.m3u8')
      return send(200, 'application/vnd.apple.mpegurl', mediaPlaylist());

    if (path === '/media/manifest.mpd') return send(200, 'application/dash+xml', dashManifest());
    if (path === '/media/protected.mpd')
      return send(200, 'application/dash+xml', protectedDashManifest());

    const dashInit = /^\/media\/dash\/(v1080|v720|a128)\/init\.mp4$/.exec(path);
    if (dashInit) return send(200, 'video/mp4', DASH_INIT);

    const dashSegment = /^\/media\/dash\/(v1080|v720|a128)\/seg-(\d+)\.m4s$/.exec(path);
    if (dashSegment) {
      // $Number$ starts at 1; the array does not.
      const body = DASH_SEGMENTS[Number(dashSegment[2]) - 1];
      if (!body) return send(404, 'text/plain', 'no such segment');
      return send(200, 'video/mp4', body);
    }

    const init = /^\/media\/(1080|720|480)\/init\.mp4$/.exec(path);
    if (init) return send(200, 'video/mp4', HLS_INIT);

    const segment = /^\/media\/(1080|720|480)\/seg-(\d+)\.m4s$/.exec(path);
    if (segment) {
      const index = Number(segment[2]);
      const body = HLS_SEGMENTS[index];
      if (!body) return send(404, 'text/plain', 'no such segment');
      return send(200, 'video/mp4', body);
    }

    send(404, 'text/plain', 'not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  siteOrigin = `http://127.0.0.1:${port}`;
  const closeServer = (target: Server) =>
    new Promise<void>((resolve, reject) => target.close((err) => (err ? reject(err) : resolve())));

  return {
    origin: siteOrigin,
    cdnOrigin,
    requests: seen,
    close: async () => {
      await Promise.all([closeServer(server), closeServer(cdn)]);
    },
    sizes: {
      featureMp4: FEATURE_MP4_BYTES,
      slowMp4: SLOW_MP4_BYTES,
      hlsInit: HLS_INIT_BYTES,
      hlsSegment: HLS_SEGMENT_BYTES,
      hlsSegments: HLS_SEGMENT_COUNT,
      dashInit: DASH_INIT_BYTES,
      dashSegment: DASH_SEGMENT_BYTES,
      dashSegments: DASH_SEGMENT_COUNT,
      onDemandMp4: ON_DEMAND_MP4_BYTES,
      choiceLargeSegments: CHOICE_LARGE_SEGMENTS,
    },
  };
}
