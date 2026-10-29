/**
 * D21: every candidate, and every rendition where it differs, says whether it
 * can be saved - decided during the scan, from what the manifests say, so a
 * row listed as saveable does not fail on click for a reason knowable before
 * it. The scan tests run the real engine and the real manifest loader against
 * a fake network, so each one exercises the path a page takes.
 */
import { describe, expect, it } from 'vitest';
import { MAX_ASSEMBLY_BYTES } from '../../src/core/limits.ts';
import type {
  MediaCandidate,
  MediaVariant,
  Saveability,
  ScanResult,
} from '../../src/core/types.ts';
import { makeCandidate } from '../../src/detection/candidate.ts';
import { runScan, type ScanInput } from '../../src/detection/engine.ts';
import { ManifestCache, uncachedLoader } from '../../src/detection/manifest-cache.ts';
import {
  type HlsMediaFacts,
  loadManifestDetails,
  withManifestDetails,
} from '../../src/detection/manifest-loader.ts';
import { assessSaveability } from '../../src/detection/saveability.ts';
import { renditionToFetch } from '../../src/downloads/task-factory.ts';
import { parseDashManifest } from '../../src/manifests/dash/parse.ts';
import { buildSegmentPlan, countSegments } from '../../src/manifests/dash/segments.ts';
import { MAX_PLAN_SEGMENTS } from '../../src/manifests/segment-plan.ts';
import { pickBestDownload, recommend } from '../../src/media/quality.ts';
import { renditionSaveability, saveabilityOf } from '../../src/media/saveability.ts';
import {
  mainDownloadBlock,
  nothingSaveableHint,
  unsaveableReason,
} from '../../src/ui/lib/media-view.ts';

const PAGE = 'https://site.example/watch/1';
const CDN = 'https://cdn.example/show';

// ─── A fake network and the real scan ───────────────────────────────────────

function network(files: Record<string, string>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    const body = files[url];
    return body === undefined
      ? new Response('not found', { status: 404 })
      : new Response(body, { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function scanOf(urls: string[], manifests: ScanInput['manifests']): Promise<ScanResult> {
  return runScan({
    tabId: 1,
    pageUrl: PAGE,
    pageTitle: 'Watch',
    pageCandidates: [],
    networkCandidates: urls.map((url) =>
      makeCandidate({ url, pageUrl: PAGE, kind: 'video', source: 'network' }),
    ),
    signals: { hasMediaSource: false, hasMediaKeys: false, mediaElements: 1, playerFrames: 0 },
    requestsObserved: 10,
    ...(manifests ? { manifests } : {}),
  });
}

function only(scan: ScanResult, url: string): MediaCandidate {
  const found = scan.candidates.find((candidate) => candidate.url === url);
  if (!found) throw new Error(`${url} is not in the scan`);
  return found;
}

/** A master with a 4K, a 1080p and a 360p rung, all with sound. */
const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2"
2160/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080/index.m3u8
`;

/** A media playlist of `count` six-second segments; finished unless `live`. */
function mediaPlaylist(count: number, options: { key?: string; live?: boolean } = {}): string {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:0'];
  if (!options.live) lines.push('#EXT-X-PLAYLIST-TYPE:VOD');
  if (options.key) lines.push(options.key);
  for (let i = 0; i < count; i += 1) lines.push('#EXTINF:6.0,', `seg${i}.ts`);
  if (!options.live) lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

const AES_128 = '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k.bin",IV=0x1';

// ─── The scan decides ───────────────────────────────────────────────────────

describe('D21: an HLS master is judged by its best rendition, probed during the scan', () => {
  it('D21: an AES-128 media playlist makes the stream "encrypted": shown, disabled, with the reason', async () => {
    const net = network({
      [`${CDN}/master.m3u8`]: MASTER,
      [`${CDN}/2160/index.m3u8`]: mediaPlaylist(300, { key: AES_128 }),
    });
    const scan = await scanOf([`${CDN}/master.m3u8`], { details: uncachedLoader(net) });
    const stream = only(scan, `${CDN}/master.m3u8`);

    expect(stream.saveability).toBe('encrypted');
    expect(unsaveableReason(saveabilityOf(stream))).toMatch(/^Encrypted stream\./);
    expect(pickBestDownload(scan.candidates)).toBeUndefined();
    // One probe, of the best rendition - not of every rung.
    expect(net.calls).toEqual([`${CDN}/master.m3u8`, `${CDN}/2160/index.m3u8`]);
  });

  it('D21: a live media playlist makes the stream "live"', async () => {
    const net = network({
      [`${CDN}/master.m3u8`]: MASTER,
      [`${CDN}/2160/index.m3u8`]: mediaPlaylist(5, { live: true }),
    });
    const scan = await scanOf([`${CDN}/master.m3u8`], { details: uncachedLoader(net) });
    const stream = only(scan, `${CDN}/master.m3u8`);

    expect(stream.live).toBe(true);
    expect(stream.saveability).toBe('live');
    expect(unsaveableReason('live')).toMatch(/^Live stream\./);
  });

  it('D21: a clear, finished stream is saveable, and the probe tells its length and segments', async () => {
    const net = network({
      [`${CDN}/master.m3u8`]: MASTER,
      [`${CDN}/2160/index.m3u8`]: `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\na.m4s\n#EXTINF:6,\nb.m4s\n#EXT-X-ENDLIST\n`,
    });
    const scan = await scanOf([`${CDN}/master.m3u8`], { details: uncachedLoader(net) });
    const stream = only(scan, `${CDN}/master.m3u8`);
    const uhd = stream.variants?.find((variant) => variant.resolution?.height === 2160);

    expect(stream.saveability).toBe('saveable');
    expect(stream.duration).toBe(12);
    expect(uhd?.segmentCount).toBe(2);
    expect(uhd?.format).toBe('mp4');
    expect(scan.stats.manifestsParsed).toBe(2);
  });

  it('D21: a rendition too large to assemble is disabled, and Best takes the next rung', async () => {
    // 300 x 6 s = 30 minutes: 4K at 16 Mbps is ~3.6 GB, 1080p at 5 Mbps ~1.1 GB.
    const net = network({
      [`${CDN}/master.m3u8`]: MASTER,
      [`${CDN}/2160/index.m3u8`]: mediaPlaylist(300),
    });
    const scan = await scanOf([`${CDN}/master.m3u8`], { details: uncachedLoader(net) });
    const stream = only(scan, `${CDN}/master.m3u8`);
    const uhd = stream.variants?.find((variant) => variant.resolution?.height === 2160);

    expect(stream.saveability).toBe('saveable');
    expect(uhd && renditionSaveability(stream, uhd)).toBe('too-large');
    expect(unsaveableReason('too-large')).toBe('Too large to assemble in the browser.');
    expect(pickBestDownload(scan.candidates)?.variant?.resolution?.height).toBe(1080);
  });

  it('D21: the probe goes through the manifest cache, so a burst of scans fetches it once', async () => {
    const net = network({
      [`${CDN}/master.m3u8`]: MASTER,
      [`${CDN}/2160/index.m3u8`]: mediaPlaylist(10),
    });
    const cache = new ManifestCache(uncachedLoader(net));
    await scanOf([`${CDN}/master.m3u8`], cache);
    await scanOf([`${CDN}/master.m3u8`], cache);
    await scanOf([`${CDN}/master.m3u8`], cache);

    expect(net.calls.filter((url) => url.endsWith('/2160/index.m3u8'))).toHaveLength(1);
    expect(net.calls.filter((url) => url.endsWith('/master.m3u8'))).toHaveLength(1);
  });

  it('D21: a DRM master is not probed: it is protected whatever its segments say', async () => {
    const drmMaster = `#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"\n${MASTER.slice('#EXTM3U\n'.length)}`;
    const net = network({ [`${CDN}/master.m3u8`]: drmMaster });
    const scan = await scanOf([`${CDN}/master.m3u8`], { details: uncachedLoader(net) });

    expect(only(scan, `${CDN}/master.m3u8`).saveability).toBe('drm');
    expect(pickBestDownload(scan.candidates)).toBeUndefined();
    expect(net.calls).toEqual([`${CDN}/master.m3u8`]);
  });

  it('D21: a failed probe leaves the stream undecided and offered, as before', async () => {
    const net = network({ [`${CDN}/master.m3u8`]: MASTER });
    const scan = await scanOf([`${CDN}/master.m3u8`], { details: uncachedLoader(net) });
    const stream = only(scan, `${CDN}/master.m3u8`);

    expect(stream.saveability).toBe('saveable');
    expect(stream.duration).toBeUndefined();
    expect(pickBestDownload(scan.candidates)?.candidate.id).toBe(stream.id);
  });
});

describe('D21: a playlist found on its own, and a DASH manifest, are judged by what they say', () => {
  it('D21: an AES-128 media playlist on its own is "encrypted"', async () => {
    const net = network({ [`${CDN}/solo.m3u8`]: mediaPlaylist(3, { key: AES_128 }) });
    const scan = await scanOf([`${CDN}/solo.m3u8`], { details: uncachedLoader(net) });
    expect(only(scan, `${CDN}/solo.m3u8`).saveability).toBe('encrypted');
  });

  it('D21: a multi-Period MPD is refused before the click, as the download would', async () => {
    const mpd = `<MPD type="static" mediaPresentationDuration="PT20S">
      <Period id="ad" duration="PT10S">
        <AdaptationSet contentType="video" mimeType="video/mp4">
          <SegmentTemplate media="ad/$Number$.m4s" duration="2" startNumber="1"/>
          <Representation id="v" bandwidth="1000000" width="1280" height="720"/>
        </AdaptationSet>
      </Period>
      <Period id="show" duration="PT10S">
        <AdaptationSet contentType="video" mimeType="video/mp4">
          <SegmentTemplate media="show/$Number$.m4s" duration="2" startNumber="1"/>
          <Representation id="v" bandwidth="1000000" width="1280" height="720"/>
        </AdaptationSet>
      </Period>
    </MPD>`;
    const net = network({ [`${CDN}/show.mpd`]: mpd });
    const scan = await scanOf([`${CDN}/show.mpd`], { details: uncachedLoader(net) });
    const stream = only(scan, `${CDN}/show.mpd`);

    expect(stream.saveability).toBe('multi-period');
    expect(unsaveableReason('multi-period')).toMatch(/cannot be joined into one file/);
  });

  it('D21: each DASH representation carries the segment count its download would have', async () => {
    const mpd = `<MPD type="static" mediaPresentationDuration="PT60S">
      <Period id="p">
        <AdaptationSet contentType="video" mimeType="video/mp4">
          <SegmentTemplate media="$RepresentationID$/$Number$.m4s" duration="4" startNumber="1"/>
          <Representation id="v" bandwidth="1000000" width="1280" height="720"/>
        </AdaptationSet>
        <AdaptationSet contentType="audio" mimeType="audio/mp4">
          <Representation id="a" bandwidth="128000"><BaseURL>audio.m4a</BaseURL></Representation>
        </AdaptationSet>
      </Period>
    </MPD>`;
    const details = await loadManifestDetails(
      `${CDN}/m.mpd`,
      'dash',
      network({ [`${CDN}/m.mpd`]: mpd }),
    );

    expect(details.variants?.[0]?.segmentCount).toBe(15);
    // A single-file representation is a plain download: no plan, no count.
    expect(details.audioTracks?.[0]?.protocol).toBe('progressive');
    expect(details.audioTracks?.[0]?.segmentCount).toBeUndefined();
    expect(details.facts).toEqual({ document: 'dash', periods: 1 });
  });

  it('keeps the facts off the candidate: they are the scan’s, not stored with the result', () => {
    const merged = withManifestDetails(candidate(), {
      protocol: 'hls',
      variants: [],
      facts: { document: 'hls-master' },
    });
    expect('facts' in merged).toBe(false);
  });
});

describe('countSegments agrees with the plan the download builds', () => {
  const mpds: Record<string, string> = {
    'template-duration': `<MPD type="static" mediaPresentationDuration="PT7S"><Period id="p">
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <SegmentTemplate media="$Number$.m4s" duration="2000" timescale="1000"/>
        <Representation id="v" bandwidth="1000"/></AdaptationSet></Period></MPD>`,
    'template-timeline': `<MPD type="static" mediaPresentationDuration="PT20S"><Period id="p" duration="PT20S">
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <SegmentTemplate media="$Time$.m4s" timescale="1000">
          <SegmentTimeline><S t="0" d="5000" r="1"/><S d="2500" r="-1"/></SegmentTimeline>
        </SegmentTemplate>
        <Representation id="v" bandwidth="1000"/></AdaptationSet></Period></MPD>`,
    list: `<MPD type="static" mediaPresentationDuration="PT8S"><Period id="p">
      <AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="1000">
        <SegmentList duration="4000" timescale="1000"><SegmentURL media="a.m4s"/><SegmentURL media="b.m4s"/></SegmentList>
      </Representation></AdaptationSet></Period></MPD>`,
    base: `<MPD type="static" mediaPresentationDuration="PT8S"><Period id="p">
      <AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="1000">
        <BaseURL>whole.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`,
    'no period length': `<MPD type="static"><Period id="p">
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <SegmentTemplate media="$Number$.m4s" duration="2000" timescale="1000"/>
        <Representation id="v" bandwidth="1000"/></AdaptationSet></Period></MPD>`,
  };

  for (const [mode, text] of Object.entries(mpds)) {
    it(`D21: ${mode}`, () => {
      const manifest = parseDashManifest(text, 'https://cdn.example/m.mpd');
      const period = manifest.periods[0];
      const rep = period?.representations[0];
      if (!period || !rep) throw new Error('fixture has no representation');
      const options = {
        ...(period.duration !== undefined ? { periodDuration: period.duration } : {}),
        live: manifest.live,
      };
      expect(countSegments(rep, options)).toBe(buildSegmentPlan(rep, options).segments.length);
    });
  }

  it('D21: stops one past the cap, where the plan would be refused', () => {
    const hours = Math.ceil((MAX_PLAN_SEGMENTS * 2) / 3600) + 1;
    const text = `<MPD type="static" mediaPresentationDuration="PT${hours}H"><Period id="p">
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <SegmentTemplate media="$Number$.m4s" duration="2"/>
        <Representation id="v" bandwidth="1000"/></AdaptationSet></Period></MPD>`;
    const manifest = parseDashManifest(text, 'https://cdn.example/m.mpd');
    const rep = manifest.periods[0]?.representations[0];
    if (!rep) throw new Error('fixture has no representation');
    expect(countSegments(rep, { periodDuration: hours * 3600 })).toBe(MAX_PLAN_SEGMENTS + 1);
  });
});

// ─── The rules, one by one ──────────────────────────────────────────────────

function candidate(overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return {
    id: 'c',
    url: `${CDN}/master.m3u8`,
    pageUrl: PAGE,
    kind: 'video',
    protocol: 'hls',
    format: 'ts',
    source: 'network',
    seenAt: 1,
    tracks: { video: true, audio: true },
    ...overrides,
  };
}

function rung(
  height: number,
  bandwidth: number,
  overrides: Partial<MediaVariant> = {},
): MediaVariant {
  return {
    id: `v${height}`,
    url: `${CDN}/${height}/index.m3u8`,
    kind: 'video',
    protocol: 'hls',
    format: 'ts',
    bandwidth,
    resolution: { width: Math.round((height * 16) / 9), height },
    tracks: { video: true, audio: true },
    ...overrides,
  };
}

/** An audio-only variant of a master: Apple's low-bandwidth fallback rung, sound and no picture. */
function audioOnlyVariant(overrides: Partial<MediaVariant> = {}): MediaVariant {
  return {
    id: 'a64',
    url: `${CDN}/a64/index.m3u8`,
    kind: 'audio',
    protocol: 'hls',
    format: 'ts',
    bandwidth: 64_000,
    codecs: ['mp4a.40.2'],
    tracks: { video: false, audio: true },
    ...overrides,
  };
}

const clear = (segmentCount: number): HlsMediaFacts => ({
  document: 'hls-media',
  encrypted: false,
  iframesOnly: false,
  segmentCount,
  container: 'ts',
});

/** Seconds of `bandwidth` that just exceed the assembly ceiling. */
function secondsOver(bandwidth: number): number {
  return Math.ceil((MAX_ASSEMBLY_BYTES * 8) / bandwidth) + 60;
}

describe('D21: the whole candidate', () => {
  it('D21: a DRM candidate cannot be saved, whatever else is true', () => {
    expect(assessSaveability(candidate({ drm: true, live: true }), clear(10)).saveability).toBe(
      'drm',
    );
    expect(unsaveableReason('drm')).toBe('Protected content. MediaGrab does not remove DRM.');
  });

  it('D21: a direct file is saveable unless DRM or blob', () => {
    const file = candidate({ protocol: 'progressive', format: 'mp4', url: `${CDN}/a.mp4` });
    expect(assessSaveability(file, undefined).saveability).toBe('saveable');
    expect(assessSaveability({ ...file, protocol: 'blob' }, undefined).saveability).toBe(
      'media-source',
    );
    // A huge direct file is the browser's to write: no assembly ceiling applies.
    expect(
      assessSaveability({ ...file, sizeBytes: MAX_ASSEMBLY_BYTES * 4 }, undefined).saveability,
    ).toBe('saveable');
  });

  it('D21: a manifest the scan did not read is left undecided, not called saveable', () => {
    expect(assessSaveability(candidate(), undefined).saveability).toBeUndefined();
  });

  it('D21: more segments than one plan may hold is too large, for the whole ladder', () => {
    const stream = candidate({ variants: [rung(1080, 5_000_000), rung(360, 800_000)] });
    expect(assessSaveability(stream, clear(MAX_PLAN_SEGMENTS + 1)).saveability).toBe('too-large');
    expect(assessSaveability(stream, clear(MAX_PLAN_SEGMENTS)).saveability).toBe('saveable');
  });

  it('D21: a manifest with nothing to fetch is "no rendition"', () => {
    expect(
      assessSaveability(candidate({ variants: [] }), { document: 'hls-master' }).saveability,
    ).toBe('no-rendition');
    expect(
      assessSaveability(candidate({ protocol: 'dash', variants: [] }), {
        document: 'dash',
        periods: 1,
      }).saveability,
    ).toBe('no-rendition');
    expect(
      assessSaveability(candidate({ variants: [] }), { ...clear(4), iframesOnly: true })
        .saveability,
    ).toBe('no-rendition');
    expect(assessSaveability(candidate({ variants: [] }), clear(0)).saveability).toBe(
      'no-rendition',
    );
    // A media playlist on its own, with segments, is its own rendition.
    expect(assessSaveability(candidate({ variants: [] }), clear(4)).saveability).toBe('saveable');
  });
});

describe('D21: each rendition', () => {
  it('D21: marks only the renditions that differ; every one too large makes the row too large', () => {
    const duration = secondsOver(5_000_000);
    const some = assessSaveability(
      candidate({ duration, variants: [rung(1080, 5_000_000), rung(360, 800_000)] }),
      clear(100),
    );
    expect(some.saveability).toBe('saveable');
    expect(some.variants?.map((variant) => variant.saveability)).toEqual(['too-large', undefined]);

    const all = assessSaveability(
      candidate({
        duration: secondsOver(800_000),
        variants: [rung(1080, 5_000_000), rung(360, 800_000)],
      }),
      clear(100),
    );
    expect(all.saveability).toBe('too-large');
    expect(pickBestDownload([all])).toBeUndefined();
  });

  it('D21: an audio-only variant that fits does not make a ladder saveable when every video rung is too large', () => {
    // A five-hour replay. The 64k audio-only variant fits, the 360p and 720p
    // rungs do not - and "best" only ever chooses among the video rungs, so a
    // row called saveable would enable a button whose click is refused.
    const judged = assessSaveability(
      candidate({
        duration: 5 * 3600,
        variants: [audioOnlyVariant(), rung(360, 800_000), rung(720, 2_500_000)],
      }),
      clear(3000),
    );

    expect(judged.variants?.map((variant) => variant.saveability)).toEqual([
      undefined,
      'too-large',
      'too-large',
    ]);
    expect(judged.saveability).toBe('too-large');
    expect(recommend(judged)).toEqual([]);
    expect(pickBestDownload([judged])).toBeUndefined();
    // What a click would fetch is refused for the very reason the row shows.
    const fetched = renditionToFetch(judged);
    expect(fetched && renditionSaveability(judged, fetched)).toBe(judged.saveability);
  });

  it('D21: uses the average bitrate where the manifest gives one, as the size shown does', () => {
    const duration = secondsOver(5_000_000);
    const averaged = rung(1080, 8_000_000, { averageBandwidth: 4_000_000 });
    const judged = assessSaveability(candidate({ duration, variants: [averaged] }), clear(100));
    expect(judged.variants?.[0]?.saveability).toBeUndefined();
  });

  it('D21: a DASH representation with no segments, or too many, is marked', () => {
    const dash = (id: string, segmentCount: number): MediaVariant =>
      rung(720, 1_000_000, {
        id,
        protocol: 'dash',
        segmentCount,
        tracks: { video: true, audio: false },
      });
    const judged = assessSaveability(
      candidate({
        protocol: 'dash',
        variants: [dash('none', 0), dash('many', MAX_PLAN_SEGMENTS + 1), dash('fine', 900)],
      }),
      { document: 'dash', periods: 1 },
    );
    expect(judged.variants?.map((variant) => variant.saveability)).toEqual([
      'no-rendition',
      'too-large',
      undefined,
    ]);
  });

  it('D21: judges the separate audio tracks too', () => {
    const audio: MediaVariant = {
      id: 'a',
      url: `${CDN}/a.m3u8`,
      kind: 'audio',
      protocol: 'hls',
      format: 'ts',
      bandwidth: 5_000_000,
      tracks: { video: false, audio: true },
    };
    const judged = assessSaveability(
      candidate({
        duration: secondsOver(5_000_000),
        variants: [rung(360, 800_000)],
        audioTracks: [audio],
      }),
      clear(100),
    );
    expect(judged.audioTracks?.[0]?.saveability).toBe('too-large');
  });
});

describe('D21: reading it back, and saying it', () => {
  it('D21: a stored scan from an older build still refuses DRM and blob candidates', () => {
    expect(saveabilityOf(candidate({ drm: true }))).toBe('drm');
    expect(saveabilityOf(candidate({ protocol: 'blob' }))).toBe('media-source');
    expect(saveabilityOf(candidate())).toBeUndefined();
  });

  it('D21: a row whose ladder has nothing "best" can take disables its main button, with the reason', () => {
    // The scan and "best" drifted apart: the row says saveable, yet every
    // video rung is too large and only an audio-only variant would fit.
    const drifted = candidate({
      saveability: 'saveable',
      variants: [
        audioOnlyVariant(),
        rung(360, 800_000, { saveability: 'too-large' }),
        rung(720, 2_500_000, { saveability: 'too-large' }),
      ],
    });
    expect(mainDownloadBlock(drifted, recommend(drifted)[0])).toBe(
      'Too large to assemble in the browser.',
    );

    // A ladder with something to take, and a direct file with no ladder, are left alone.
    const fine = candidate({ saveability: 'saveable', variants: [rung(720, 2_500_000)] });
    expect(mainDownloadBlock(fine, recommend(fine)[0])).toBeNull();
    const file = candidate({ protocol: 'progressive', format: 'mp4', url: `${CDN}/a.mp4` });
    expect(mainDownloadBlock(file, recommend(file)[0])).toBeNull();
  });

  it('D21: a rendition inherits its candidate’s "no"', () => {
    const stream = candidate({ saveability: 'live', variants: [rung(720, 1_000_000)] });
    const [variant] = stream.variants ?? [];
    expect(variant && renditionSaveability(stream, variant)).toBe('live');
  });

  it('D21: every reason is one plain line, and "saveable" has none', () => {
    const reasons: Saveability[] = [
      'drm',
      'encrypted',
      'live',
      'multi-period',
      'media-source',
      'too-large',
      'no-rendition',
    ];
    for (const status of reasons) {
      const line = unsaveableReason(status);
      expect(line, status).toMatch(/^[A-Z][^\n]{10,90}\.$/);
    }
    expect(unsaveableReason('saveable')).toBeNull();
    expect(unsaveableReason(undefined)).toBeNull();
  });

  it('D21: "Best download" says why it is disabled - DRM by name, any other mix by pointing at the rows', () => {
    expect(nothingSaveableHint([candidate({ drm: true })])).toMatch(
      /Everything found here is protected/,
    );
    expect(
      nothingSaveableHint([candidate({ drm: true }), candidate({ saveability: 'live' })]),
    ).toBe('Nothing found here can be downloaded. Each item says why.');
  });
});
