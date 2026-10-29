/**
 * D20: "best" is one written rule - sound, then resolution, then bitrate, then
 * the combined quality score - applied only to renditions that can be saved
 * (D21); and "Best download" on a stream that only exists as separate video
 * and audio queues both, as two files.
 */
import { describe, expect, it, vi } from 'vitest';
import { MAX_ASSEMBLY_BYTES } from '../../src/core/limits.ts';
import type { MediaCandidate, MediaVariant, ScanResult } from '../../src/core/types.ts';
import { loadManifestDetails, withManifestDetails } from '../../src/detection/manifest-loader.ts';
import { assessSaveability } from '../../src/detection/saveability.ts';
import { renditionToFetch } from '../../src/downloads/task-factory.ts';
import {
  bestRenditionOf,
  bestVariantOf,
  pairAudioFor,
  pickBestDownload,
  recommend,
} from '../../src/media/quality.ts';
import { DEFAULT_SETTINGS } from '../../src/storage/settings.ts';
import type { PopupBridge } from '../../src/ui/lib/bridge.ts';
import { NO_SOUND, SEPARATE_FILES, soundNote } from '../../src/ui/lib/media-view.ts';
import { NOTICES, PopupController } from '../../src/ui/lib/popup-controller.ts';

const PAGE = 'https://site.example/watch';

function candidate(overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return {
    id: 'c',
    url: 'https://cdn.example/master.m3u8',
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

/** A video rendition; muxed (with sound) unless `sound: false`. */
function video(
  height: number,
  bandwidth: number,
  overrides: Partial<MediaVariant> & { sound?: boolean; width?: number } = {},
): MediaVariant {
  const { sound = true, width = Math.round((height * 16) / 9), ...rest } = overrides;
  return {
    id: `v${height}-${bandwidth}${sound ? '' : '-silent'}`,
    url: `https://cdn.example/${height}-${bandwidth}.m3u8`,
    kind: 'video',
    protocol: 'hls',
    format: 'ts',
    bandwidth,
    resolution: { width, height },
    codecs: sound ? ['avc1.640028', 'mp4a.40.2'] : ['avc1.640028'],
    tracks: { video: true, audio: sound },
    ...rest,
  };
}

function audio(id: string, bandwidth: number, overrides: Partial<MediaVariant> = {}): MediaVariant {
  return {
    id,
    url: `https://cdn.example/audio/${id}.m3u8`,
    kind: 'audio',
    protocol: 'hls',
    format: 'ts',
    bandwidth,
    codecs: ['mp4a.40.2'],
    tracks: { video: false, audio: true },
    ...overrides,
  };
}

const heightOf = (pick: { variant?: MediaVariant } | undefined) =>
  pick?.variant?.resolution?.height;

describe('D20: the rule', () => {
  it('D20: a worst-first ladder still yields its top rung', () => {
    const ladder = [
      video(240, 400_000),
      video(480, 1_400_000),
      video(720, 2_800_000),
      video(1080, 5_000_000),
    ];
    expect(heightOf(pickBestDownload([candidate({ variants: ladder })]))).toBe(1080);
  });

  it('D20: 1080p with sound beats 4K without', () => {
    const stream = candidate({
      variants: [
        video(2160, 16_000_000, { sound: false, audioGroupId: 'aac' }),
        video(1080, 5_000_000),
      ],
      audioTracks: [audio('aac-en', 128_000, { audioGroupId: 'aac' })],
    });
    const best = pickBestDownload([stream]);
    expect(heightOf(best)).toBe(1080);
    expect(best?.audio).toBeUndefined();
  });

  it('D20: resolution comes before bitrate', () => {
    const stream = candidate({ variants: [video(720, 9_000_000), video(1080, 4_000_000)] });
    expect(heightOf(bestRenditionOf(stream))).toBe(1080);
  });

  it('D20: on one rung, bitrate decides - a 1918x1076 encode is the 1080p it is labelled', () => {
    const cropped = video(1076, 8_000_000, { width: 1918 });
    const exact = video(1080, 5_000_000);
    expect(bestRenditionOf(candidate({ variants: [exact, cropped] }))?.variant.id).toBe(cropped.id);
  });

  it('D20: bitrate comes before the quality score', () => {
    // HEVC scores higher per bit than H.264, but the rule weighs bits first.
    const hevc = video(1080, 5_000_000, { id: 'hevc', codecs: ['hvc1.1.6.L120', 'mp4a.40.2'] });
    const avc = video(1080, 6_000_000, { id: 'avc' });
    expect(bestRenditionOf(candidate({ variants: [hevc, avc] }))?.variant.id).toBe('avc');
  });

  it('D20: the combined quality score breaks a full tie (codec, frame rate)', () => {
    const plain = video(1080, 5_000_000, { id: 'plain' });
    const smooth = video(1080, 5_000_000, { id: 'smooth', fps: 60 });
    expect(bestRenditionOf(candidate({ variants: [plain, smooth] }))?.variant.id).toBe('smooth');
  });

  it('D20: a stream that exists only as split video and audio gets both', () => {
    const dashVideo = (height: number, bandwidth: number) =>
      video(height, bandwidth, {
        sound: false,
        protocol: 'dash',
        url: 'https://cdn.example/m.mpd',
      });
    const stream = candidate({
      protocol: 'dash',
      url: 'https://cdn.example/m.mpd',
      variants: [dashVideo(720, 2_600_000), dashVideo(1080, 4_800_000)],
      audioTracks: [
        audio('a64', 64_000, { protocol: 'dash' }),
        audio('a128', 128_000, { protocol: 'dash' }),
      ],
    });
    const best = pickBestDownload([stream]);
    expect(heightOf(best)).toBe(1080);
    expect(best?.audio?.id).toBe('a128');
    expect(soundNote(best)).toBe(SEPARATE_FILES);
  });

  it('D20: HLS pairs the audio group the rendition names', () => {
    const stream = candidate({
      variants: [video(1080, 5_000_000, { sound: false, audioGroupId: 'lo' })],
      audioTracks: [
        audio('hi', 256_000, { audioGroupId: 'hi' }),
        audio('lo', 96_000, { audioGroupId: 'lo' }),
      ],
    });
    expect(pickBestDownload([stream])?.audio?.id).toBe('lo');
  });

  it('D20: with no audio track to pair, a silent rendition is still offered, and says so', () => {
    const stream = candidate({ variants: [video(1080, 5_000_000, { sound: false })] });
    const best = pickBestDownload([stream]);
    expect(heightOf(best)).toBe(1080);
    expect(best?.audio).toBeUndefined();
    expect(soundNote(best)).toBe(NO_SOUND);
  });

  it('D20: a direct file is its own best', () => {
    const file = candidate({
      protocol: 'progressive',
      format: 'mp4',
      url: 'https://cdn.example/a.mp4',
    });
    expect(pickBestDownload([file])).toEqual({ candidate: file });
  });
});

describe('D20 + D21: only what can be saved takes part', () => {
  /** Seconds after which `bandwidth` no longer fits the in-memory assembly ceiling. */
  const tooLongFor = (bandwidth: number) => Math.ceil((MAX_ASSEMBLY_BYTES * 8) / bandwidth) + 60;
  const clear = {
    document: 'hls-media',
    encrypted: false,
    iframesOnly: false,
    segmentCount: 300,
    container: 'ts',
  } as const;

  it('D21: a rendition too large to assemble is skipped for the next', () => {
    const stream = assessSaveability(
      candidate({
        duration: tooLongFor(16_000_000),
        variants: [video(2160, 16_000_000), video(1080, 5_000_000), video(480, 1_400_000)],
      }),
      clear,
    );
    expect(heightOf(pickBestDownload([stream]))).toBe(1080);
    expect(recommend(stream)[0]?.variant.resolution?.height).toBe(1080);
  });

  it('D21: a DRM candidate is skipped for the next candidate', () => {
    const drm = candidate({ id: 'drm', drm: true, variants: [video(2160, 16_000_000)] });
    const plain = candidate({ id: 'plain', variants: [video(720, 2_800_000)] });
    expect(pickBestDownload([assessSaveability(drm, undefined), plain])?.candidate.id).toBe(
      'plain',
    );
  });

  it('D21: nothing that can be saved means no Best at all', () => {
    const encrypted = candidate({ id: 'aes', variants: [video(1080, 5_000_000)] });
    const live = candidate({ id: 'live', live: true, variants: [video(720, 3_000_000)] });
    expect(
      pickBestDownload([
        assessSaveability(encrypted, { ...clear, encrypted: true }),
        assessSaveability(live, clear),
      ]),
    ).toBeUndefined();
  });

  it('D21: an audio track that cannot be saved is not paired; one that can is', () => {
    const stream = candidate({
      variants: [video(1080, 5_000_000, { sound: false })],
      audioTracks: [audio('huge', 320_000, { saveability: 'too-large' }), audio('fine', 128_000)],
    });
    expect(pickBestDownload([stream])?.audio?.id).toBe('fine');
  });

  it('regression: a scan stored by an older build, with no saveability, still skips DRM', () => {
    const legacy = candidate({ id: 'old-drm', drm: true, protocol: 'progressive' });
    const next = candidate({ id: 'next', protocol: 'progressive' });
    expect(pickBestDownload([legacy, next])?.candidate.id).toBe('next');
  });
});

describe('D20: every "best" in the product is the same rendition', () => {
  const split = candidate({
    variants: [
      video(720, 2_800_000, { sound: false, audioGroupId: 'a' }),
      video(1080, 5_000_000, { sound: false, audioGroupId: 'a' }),
    ],
    audioTracks: [audio('en', 128_000, { audioGroupId: 'a' })],
  });

  it('D20: Best download, the row and a download queued without a rendition agree', () => {
    const best = pickBestDownload([split]);
    const [row] = recommend(split);
    expect(row?.variant.id).toBe(best?.variant?.id);
    expect(row?.audio?.id).toBe(best?.audio?.id);
    expect(bestVariantOf(split)?.id).toBe(best?.variant?.id);
    expect(renditionToFetch(split)?.id).toBe(best?.variant?.id);
  });

  it('D20: with nothing saveable, a download asked for anyway still names the rule’s pick', () => {
    const blocked = {
      ...split,
      variants: split.variants?.map((variant) => ({
        ...variant,
        saveability: 'too-large' as const,
      })),
    };
    expect(bestRenditionOf(blocked)).toBeUndefined();
    expect(bestVariantOf(blocked)?.resolution?.height).toBe(1080);
  });
});

describe('D20: "best" pairs the programme’s own sound', () => {
  /** English main, English audio description and a German dub - each louder in bitrate than the last pick. */
  const MPD = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10M">
  <Period id="p">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate media="v/$Number$.m4s" duration="4" startNumber="1"/>
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>
      <SegmentTemplate media="en/$Number$.m4s" duration="4" startNumber="1"/>
      <Representation id="en" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="description"/>
      <SegmentTemplate media="ad/$Number$.m4s" duration="4" startNumber="1"/>
      <Representation id="en-described" bandwidth="192000" codecs="mp4a.40.2"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="de">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="dub"/>
      <SegmentTemplate media="de/$Number$.m4s" duration="4" startNumber="1"/>
      <Representation id="de" bandwidth="160000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`;

  it('D20: Best pairs the main DASH audio, not a higher-bitrate audio description or dub', async () => {
    const url = 'https://cdn.example/show.mpd';
    const fetchImpl = (async () => new Response(MPD, { status: 200 })) as typeof fetch;
    const details = await loadManifestDetails(url, 'dash', { fetchImpl });
    const stream = assessSaveability(
      withManifestDetails(candidate({ url, protocol: 'dash', format: 'mp4' }), details),
      details.facts,
    );

    // The Role travels with each track: "main" is DASH's DEFAULT=YES.
    expect(
      stream.audioTracks?.map((track) => [track.dashRepresentationId, track.role, track.default]),
    ).toEqual([
      ['en', 'main', true],
      ['en-described', 'description', undefined],
      ['de', 'dub', undefined],
    ]);
    expect(pickBestDownload([stream])?.audio?.dashRepresentationId).toBe('en');
    expect(recommend(stream)[0]?.audio?.dashRepresentationId).toBe('en');
  });

  it('D20: an HLS audio description (CHARACTERISTICS describes-video) is not paired by default', async () => {
    const url = 'https://cdn.example/show.m3u8';
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English (described)",LANGUAGE="en",CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog, public.accessibility.describes-video",URI="ad.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"',
      'v1080.m3u8',
    ].join('\n');
    const fetchImpl = (async () => new Response(master, { status: 200 })) as typeof fetch;
    const details = await loadManifestDetails(url, 'hls', { fetchImpl });
    const stream = withManifestDetails(candidate({ url, protocol: 'hls', format: 'ts' }), details);
    expect(stream.audioTracks?.map((track) => [track.label, track.role])).toEqual([
      ['English (described)', 'description'],
      ['English', undefined],
    ]);
    const [video1080] = stream.variants ?? [];
    expect(video1080 && pairAudioFor(video1080, stream.audioTracks ?? [])?.label).toBe('English');
  });

  it('D20 (verification): DVB audio description - Role "main" plus Accessibility AudioPurpose 1 - is not the programme', async () => {
    const url = 'https://cdn.example/dvb.mpd';
    const mpd = MPD.replace(
      '<Role schemeIdUri="urn:mpeg:dash:role:2011" value="description"/>',
      '<Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>\n      <Accessibility schemeIdUri="urn:tva:metadata:cs:AudioPurposeCS:2007" value="1"/>',
    );
    const fetchImpl = (async () => new Response(mpd, { status: 200 })) as typeof fetch;
    const details = await loadManifestDetails(url, 'dash', { fetchImpl });
    const stream = withManifestDetails(
      candidate({ url, protocol: 'dash', format: 'mp4' }),
      details,
    );
    const described = stream.audioTracks?.find(
      (track) => track.dashRepresentationId === 'en-described',
    );
    expect(described?.role).toBe('description');
    expect(pickBestDownload([stream])?.audio?.dashRepresentationId).toBe('en');

    // AudioPurpose 4, the director's commentary, is not the programme either.
    const commentary = mpd.replace(
      'AudioPurposeCS:2007" value="1"',
      'AudioPurposeCS:2007" value="4"',
    );
    const withCommentary = withManifestDetails(
      candidate({ url, protocol: 'dash', format: 'mp4' }),
      await loadManifestDetails(url, 'dash', {
        fetchImpl: (async () => new Response(commentary, { status: 200 })) as typeof fetch,
      }),
    );
    expect(pickBestDownload([withCommentary])?.audio?.dashRepresentationId).toBe('en');
  });

  it('D20 (verification): with nothing marked default, the first-listed language wins over a louder dub', () => {
    const silent = video(1080, 5_000_000, { sound: false });
    const tracks = [
      audio('en', 128_000, { language: 'en' }),
      audio('de', 160_000, { language: 'de' }),
    ];
    expect(pairAudioFor(silent, tracks)?.id).toBe('en');
  });

  it('D20: audio description and commentary lose to the programme’s sound even with no default marked', () => {
    const silent = video(1080, 5_000_000, { sound: false });
    const described = audio('described', 192_000, { language: 'en', role: 'description' });
    const tracks = [
      described,
      audio('commentary', 256_000, { language: 'en', role: 'commentary' }),
      audio('en', 128_000, { language: 'en' }),
    ];
    expect(pairAudioFor(silent, tracks)?.id).toBe('en');
    // When it is all there is, a description is still sound: better than none.
    expect(pairAudioFor(silent, [described])?.id).toBe('described');
  });

  it('D20: among several main tracks, the first one listed sets the language, then bitrate decides', () => {
    const silent = video(1080, 5_000_000, { sound: false });
    const main = { role: 'main', default: true };
    const tracks = [
      audio('en-aac', 128_000, { language: 'en', ...main }),
      audio('de-aac', 400_000, { language: 'de', ...main }),
      audio('en-ec3', 256_000, { language: 'en', codecs: ['ec-3'], ...main }),
    ];
    expect(pairAudioFor(silent, tracks)?.id).toBe('en-ec3');
  });
});

// ─── The popup ──────────────────────────────────────────────────────────────

function scanWith(candidates: MediaCandidate[]): ScanResult {
  return {
    tabId: 7,
    pageUrl: PAGE,
    pageTitle: 'Watch',
    scannedAt: 1,
    candidates,
    rejected: [],
    stats: {
      networkRequestsObserved: 0,
      mediaElements: 1,
      candidatesRaw: candidates.length,
      candidatesAfterDedupe: candidates.length,
      manifestsParsed: 0,
      byProtocol: { progressive: 0, hls: candidates.length, dash: 0, blob: 0, data: 0, unknown: 0 },
      parseErrors: 0,
    },
  };
}

async function popupOver(
  scan: ScanResult,
  startDownload: PopupBridge['startDownload'],
): Promise<PopupController> {
  const bridge: PopupBridge = {
    currentTab: async () => ({ id: 7, url: PAGE, title: 'Watch' }),
    getScan: async () => scan,
    requestScan: async () => scan,
    getDownloads: async () => [],
    startDownload,
    sendDownloadCommand: async () => undefined,
    onBackgroundMessage: () => () => undefined,
    loadSettings: async () => structuredClone(DEFAULT_SETTINGS),
    hasSiteAccess: async () => true,
    requestSiteAccess: async () => true,
    requestHostAccess: async () => true,
    extensionVersion: () => '0.0.0',
    copyToClipboard: async () => true,
    openOptions: () => undefined,
  };
  const controller = new PopupController(bridge, () => undefined);
  await controller.start();
  return controller;
}

describe('D20: "Best download" in the popup queues the video and its audio', () => {
  const split = candidate({
    id: 'split',
    variants: [video(1080, 5_000_000, { id: 'v1080', sound: false })],
    audioTracks: [audio('en', 128_000)],
  });

  it('D20: two START_DOWNLOADs on a split stream, the video first, then the Downloads view', async () => {
    const startDownload = vi.fn<PopupBridge['startDownload']>(async () => ({ ok: true }));
    const controller = await popupOver(scanWith([split]), startDownload);

    await controller.downloadBest();
    expect(startDownload.mock.calls).toEqual([
      [7, 'split', 'v1080'],
      [7, 'split', 'en'],
    ]);
    expect(controller.state.view).toBe('downloads');
    expect(controller.state.notice).toBeNull();
  });

  it('D20: a stream with its own sound is one download', async () => {
    const muxed = candidate({ id: 'muxed', variants: [video(1080, 5_000_000, { id: 'v' })] });
    const startDownload = vi.fn<PopupBridge['startDownload']>(async () => ({ ok: true }));
    const controller = await popupOver(scanWith([muxed]), startDownload);

    await controller.downloadBest();
    expect(startDownload.mock.calls).toEqual([[7, 'muxed', 'v']]);
  });

  it('D20: a refused video never leaves a lone audio download behind', async () => {
    const startDownload = vi.fn<PopupBridge['startDownload']>(async () => ({
      ok: false,
      error: 'That quality is no longer offered. Scan the page again.',
    }));
    const controller = await popupOver(scanWith([split]), startDownload);

    await controller.downloadBest();
    expect(startDownload).toHaveBeenCalledTimes(1);
    expect(controller.state.view).toBe('media');
    expect(controller.state.notice).toMatch(/no longer offered/);
  });

  it('D20: says so when the audio could not start, while the video downloads', async () => {
    const startDownload = vi
      .fn<PopupBridge['startDownload']>()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false });
    const controller = await popupOver(scanWith([split]), startDownload);

    await controller.downloadBest();
    expect(controller.state.view).toBe('downloads');
    expect(controller.state.notice).toBe(NOTICES.audioNotStarted);
    expect(controller.state.busy).toBe(false);
  });

  it('D20: a row’s own button downloads the pair it shows', async () => {
    const startDownload = vi.fn<PopupBridge['startDownload']>(async () => ({ ok: true }));
    const controller = await popupOver(scanWith([split]), startDownload);
    const [row] = recommend(split);

    await controller.download(split, row?.variant, row?.audio);
    expect(startDownload.mock.calls.map(([, , variantId]) => variantId)).toEqual(['v1080', 'en']);
  });
});
