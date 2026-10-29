import { describe, expect, it } from 'vitest';
import type { MediaCandidate, MediaVariant } from '../../src/core/types.ts';
import { dedupe, merge, nearKey, sameRenditionUrl } from '../../src/media/dedupe.ts';
import {
  bucketSize,
  fingerprint,
  isVolatileParam,
  normalizeUrl,
} from '../../src/media/fingerprint.ts';
import {
  codecFamily,
  extensionOf,
  fileExtensionFor,
  guessFormat,
  tracksFromCodecs,
} from '../../src/media/format.ts';
import {
  buildFilename,
  cleanTitle,
  renderTemplate,
  sanitizeSegment,
} from '../../src/media/naming.ts';
import { backfillPosters, choosePagePoster } from '../../src/media/poster.ts';
import {
  formatBytes,
  formatDuration,
  pairAudioFor,
  qualityLabel,
  recommend,
  videoLadder,
} from '../../src/media/quality.ts';
import { DISPLAY_THRESHOLD, qualityScore, rank, scoreCandidate } from '../../src/media/score.ts';

function candidate(overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return {
    id: 'id',
    url: 'https://cdn.example/video.mp4',
    pageUrl: 'https://site.example/watch',
    pageTitle: 'A page',
    kind: 'video',
    protocol: 'progressive',
    format: 'mp4',
    source: 'network',
    seenAt: 1_000,
    tracks: { video: true, audio: true },
    ...overrides,
  };
}

function variant(overrides: Partial<MediaVariant> = {}): MediaVariant {
  return {
    id: 'v',
    url: 'https://cdn.example/v.m3u8',
    kind: 'video',
    protocol: 'hls',
    format: 'ts',
    tracks: { video: true, audio: true },
    ...overrides,
  };
}

describe('URL normalization', () => {
  it('drops volatile parameters and sorts the rest', () => {
    expect(normalizeUrl('https://cdn.example/v.mp4?token=abc&quality=hd&_=123')).toBe(
      'https://cdn.example/v.mp4?quality=hd',
    );
    expect(normalizeUrl('https://cdn.example/v.mp4?b=2&a=1')).toBe(
      'https://cdn.example/v.mp4?a=1&b=2',
    );
  });

  it('lowercases the host, drops default ports, credentials and the fragment', () => {
    expect(normalizeUrl('https://User:pass@CDN.Example:443/v.mp4#t=10')).toBe(
      'https://cdn.example/v.mp4',
    );
    expect(normalizeUrl('http://cdn.example:80/v.mp4')).toBe('http://cdn.example/v.mp4');
  });

  it('leaves blob: and data: URLs alone', () => {
    expect(normalizeUrl('blob:https://site.example/abc')).toBe('blob:https://site.example/abc');
    expect(normalizeUrl('not a url')).toBe('not a url');
  });

  it('knows which parameters are volatile', () => {
    expect(isVolatileParam('token')).toBe(true);
    expect(isVolatileParam('Expires')).toBe(true);
    expect(isVolatileParam('hdnts')).toBe(true);
    expect(isVolatileParam('quality')).toBe(false);
  });
});

describe('fingerprinting', () => {
  it('gives the same id to the same asset behind different signatures', () => {
    const a = fingerprint({ url: 'https://cdn.example/v.mp4?token=A', kind: 'video' });
    const b = fingerprint({ url: 'https://cdn.example/v.mp4?token=B', kind: 'video' });
    expect(a).toBe(b);
  });

  it('separates different renditions, which live at different URLs', () => {
    const a = fingerprint({ url: 'https://cdn.example/1080/v.mp4', kind: 'video' });
    const b = fingerprint({ url: 'https://cdn.example/720/v.mp4', kind: 'video' });
    expect(a).not.toBe(b);
  });

  it('buckets sizes so a few bytes of drift do not split one file in two', () => {
    expect(bucketSize(100_000_000)).toBe(bucketSize(100_000_400));
    expect(bucketSize(100_000_000)).not.toBe(bucketSize(140_000_000));
  });
});

describe('dedupe', () => {
  it('collapses the same media seen through three signed URLs', () => {
    const inputs = ['A', 'B', 'C'].map((token, index) =>
      candidate({
        id: fingerprint({ url: `https://cdn.example/v.mp4?token=${token}`, kind: 'video' }),
        url: `https://cdn.example/v.mp4?token=${token}`,
        seenAt: 1000 + index,
      }),
    );
    expect(dedupe(inputs)).toHaveLength(1);
  });

  it('keeps genuinely different resolutions apart', () => {
    const hd = candidate({
      id: 'hd',
      resolution: { width: 1920, height: 1080 },
      url: 'https://cdn.example/1080.mp4',
    });
    const sd = candidate({
      id: 'sd',
      resolution: { width: 640, height: 360 },
      url: 'https://cdn.example/360.mp4',
    });
    expect(dedupe([hd, sd])).toHaveLength(2);
    expect(nearKey(hd)).not.toBe(nearKey(sd));
  });

  it('merges as a union: the richer source wins, missing fields are filled', () => {
    const fromNetwork = candidate({
      id: 'x',
      source: 'network',
      sizeBytes: 1_000_000,
      sizeEstimated: false,
      seenAt: 500,
    });
    const fromDom = candidate({
      id: 'x',
      source: 'dom-element',
      title: 'Real title',
      posterUrl: 'https://cdn.example/p.jpg',
      duration: 300,
      seenAt: 900,
    });

    const merged = merge(fromNetwork, fromDom);
    expect(merged.sizeBytes).toBe(1_000_000);
    expect(merged.sizeEstimated).toBe(false);
    expect(merged.title).toBe('Real title');
    expect(merged.duration).toBe(300);
    expect(merged.seenAt).toBe(500);
  });

  it('prefers a measured size over an estimated one', () => {
    const estimated = candidate({
      id: 'x',
      source: 'adapter',
      sizeBytes: 999,
      sizeEstimated: true,
    });
    const measured = candidate({
      id: 'x',
      source: 'network',
      sizeBytes: 1234,
      sizeEstimated: false,
    });
    expect(merge(estimated, measured).sizeBytes).toBe(1234);
    expect(merge(estimated, measured).sizeEstimated).toBe(false);
  });

  it('spots a download that has already been queued', () => {
    const running = 'https://cdn.example/v.mp4?token=OLD';
    expect(sameRenditionUrl('https://cdn.example/v.mp4?token=NEW', running)).toBe(true);
    expect(sameRenditionUrl('https://cdn.example/other.mp4', running)).toBe(false);
  });
});

describe('format identification', () => {
  it('prefers the MIME type over the extension', () => {
    const guess = guessFormat(
      'https://cdn.example/looks-like.mp4',
      'application/vnd.apple.mpegurl',
    );
    expect(guess.protocol).toBe('hls');
  });

  it('falls back to the extension', () => {
    expect(guessFormat('https://cdn.example/a/b.m3u8?x=1').protocol).toBe('hls');
    expect(guessFormat('https://cdn.example/a/b.mpd').protocol).toBe('dash');
    expect(guessFormat('https://cdn.example/a/b.flac').kind).toBe('audio');
  });

  it('reports low confidence for an unidentifiable URL', () => {
    expect(guessFormat('https://cdn.example/stream/abcdef').confidence).toBe(0);
  });

  it('extracts extensions safely', () => {
    expect(extensionOf('https://cdn.example/a.b/c.mp4?x=1#y')).toBe('mp4');
    expect(extensionOf('https://cdn.example/no-extension')).toBeNull();
    expect(extensionOf('https://cdn.example/file.verylongext')).toBeNull();
  });

  it('maps codecs to families and to track flags', () => {
    expect(codecFamily('avc1.640028')).toBe('h264');
    expect(codecFamily('av01.0.05M.08')).toBe('av1');
    expect(tracksFromCodecs(['avc1.640028', 'mp4a.40.2'])).toEqual({ video: true, audio: true });
    expect(tracksFromCodecs(['mp4a.40.2'])).toEqual({ video: false, audio: true });
    expect(tracksFromCodecs([])).toBeUndefined();
  });

  it('chooses a sensible file extension when the container is unknown', () => {
    expect(fileExtensionFor('unknown', 'audio')).toBe('m4a');
    expect(fileExtensionFor('unknown', 'video')).toBe('mp4');
    expect(fileExtensionFor('webm', 'video')).toBe('webm');
  });
});

describe('scoring', () => {
  it('ranks a 1080p manifest above a thumbnail', () => {
    const stream = candidate({
      id: 'stream',
      protocol: 'hls',
      url: 'https://cdn.example/master.m3u8',
      resolution: { width: 1920, height: 1080 },
      duration: 600,
      bitrate: 5_000_000,
      variants: [variant()],
    });
    const thumb = candidate({
      id: 'thumb',
      kind: 'image',
      format: 'jpg',
      url: 'https://cdn.example/thumbs/preview.jpg',
      resolution: { width: 320, height: 180 },
      sizeBytes: 24_000,
      tracks: { video: false, audio: false },
    });

    const [best, worst] = rank([thumb, stream]);
    expect(best?.id).toBe('stream');
    expect(best?.score ?? 0).toBeGreaterThan(DISPLAY_THRESHOLD);
    expect(worst?.score ?? 100).toBeLessThan(DISPLAY_THRESHOLD);
  });

  it('penalises advertising paths hard', () => {
    const ad = candidate({
      url: 'https://cdn.example/ads/preroll.mp4',
      duration: 15,
      sizeBytes: 900_000,
    });
    const feature = candidate({
      url: 'https://cdn.example/videos/feature.mp4',
      duration: 15,
      sizeBytes: 900_000,
    });
    expect(scoreCandidate(ad).score).toBeLessThan(scoreCandidate(feature).score);
    expect(scoreCandidate(ad).reasons.join(' ')).toMatch(/advertising/);
  });

  it('drives DRM-protected media below the display threshold', () => {
    const drm = candidate({ drm: true, resolution: { width: 1920, height: 1080 }, duration: 3600 });
    expect(scoreCandidate(drm).score).toBeLessThan(DISPLAY_THRESHOLD);
  });

  it('explains every point it awards', () => {
    const { score, reasons } = scoreCandidate(
      candidate({ duration: 600, resolution: { width: 1280, height: 720 } }),
    );
    expect(reasons.length).toBeGreaterThan(3);
    expect(score).toBeGreaterThan(0);
  });

  it('prefers 1440p with good audio over 4K with poor audio', () => {
    const uhdThinAudio = qualityScore({
      height: 2160,
      bitrate: 12_000_000,
      codecs: ['avc1.640033'],
      audioBitrate: 64_000,
      audioCodec: 'mp4a.40.5',
    });
    const qhdFullAudio = qualityScore({
      height: 1440,
      bitrate: 9_000_000,
      codecs: ['av01.0.12M.08'],
      audioBitrate: 192_000,
      audioCodec: 'opus',
    });
    expect(qhdFullAudio).toBeGreaterThan(uhdThinAudio);
  });
});

describe('quality ladder', () => {
  it('labels renditions by rung, with a frame-rate suffix above 48fps', () => {
    expect(qualityLabel(variant({ resolution: { width: 1920, height: 1080 } }))).toBe('1080p');
    expect(qualityLabel(variant({ resolution: { width: 3840, height: 2160 } }))).toBe('4K');
    expect(qualityLabel(variant({ resolution: { width: 1920, height: 1080 }, fps: 60 }))).toBe(
      '1080p60',
    );
    expect(qualityLabel(variant({ resolution: { width: 1918, height: 1076 } }))).toBe('1080p');
  });

  it('keeps one entry per rung, best first', () => {
    const ladder = videoLadder([
      variant({
        id: 'a',
        resolution: { width: 1920, height: 1080 },
        bandwidth: 5_000_000,
        score: 80,
      }),
      variant({
        id: 'b',
        resolution: { width: 1920, height: 1080 },
        bandwidth: 8_000_000,
        score: 90,
      }),
      variant({
        id: 'c',
        resolution: { width: 1280, height: 720 },
        bandwidth: 3_000_000,
        score: 60,
      }),
    ]);
    expect(ladder).toHaveLength(2);
    expect(ladder[0]?.id).toBe('b');
    expect(ladder[1]?.id).toBe('c');
  });

  it('pairs a video-only variant with its declared audio group', () => {
    const video = variant({
      id: 'v',
      tracks: { video: true, audio: false },
      audioGroupId: 'aac-hi',
    });
    const wrongGroup = variant({
      id: 'a1',
      kind: 'audio',
      tracks: { video: false, audio: true },
      audioGroupId: 'aac-lo',
      bandwidth: 320_000,
    });
    const rightGroup = variant({
      id: 'a2',
      kind: 'audio',
      tracks: { video: false, audio: true },
      audioGroupId: 'aac-hi',
      bandwidth: 128_000,
    });
    expect(pairAudioFor(video, [wrongGroup, rightGroup])?.id).toBe('a2');
  });

  it('does not pair audio with a stream that already carries it', () => {
    const muxed = variant({ tracks: { video: true, audio: true } });
    expect(
      pairAudioFor(muxed, [variant({ id: 'a', tracks: { video: false, audio: true } })]),
    ).toBeUndefined();
  });

  it('recommends best, balanced and smallest', () => {
    const withLadder = candidate({
      protocol: 'hls',
      duration: 600,
      variants: [
        variant({ id: 'uhd', resolution: { width: 3840, height: 2160 }, bandwidth: 16_000_000 }),
        variant({ id: 'hd', resolution: { width: 1920, height: 1080 }, bandwidth: 5_000_000 }),
        variant({ id: 'sd', resolution: { width: 640, height: 360 }, bandwidth: 800_000 }),
      ],
    });
    const recommendations = recommend(withLadder);
    expect(recommendations[0]?.kind).toBe('best');
    expect(recommendations[0]?.variant.id).toBe('uhd');
    expect(recommendations.find((entry) => entry.kind === 'balanced')?.variant.id).toBe('hd');
    expect(recommendations.find((entry) => entry.kind === 'smallest')?.variant.id).toBe('sd');
  });

  it('formats sizes and durations for humans', () => {
    expect(formatBytes(1_288_490_189)).toBe('1.20 GB');
    expect(formatBytes(524_288, true)).toBe('~512 KB');
    expect(formatBytes(undefined)).toBe('unknown size');
    expect(formatDuration(3_725)).toBe('1:02:05');
    expect(formatDuration(65)).toBe('1:05');
  });
});

describe('filenames', () => {
  it('strips path separators, traversal and control characters', () => {
    expect(sanitizeSegment('../../etc/passwd')).toBe('etc passwd');
    expect(sanitizeSegment('..')).toBe('download');
    expect(sanitizeSegment('.hidden')).toBe('hidden');
    expect(sanitizeSegment('a/b\\c')).toBe('a b c');
    expect(sanitizeSegment(`bad${String.fromCharCode(0)}name`)).toBe('bad name');
  });

  it('escapes Windows device names', () => {
    expect(sanitizeSegment('CON.mp4')).toBe('_CON.mp4');
    expect(sanitizeSegment('lpt9.mkv')).toBe('_lpt9.mkv');
  });

  it('never returns an empty segment', () => {
    expect(sanitizeSegment('///')).toBe('download');
    expect(sanitizeSegment('   ', 'fallback')).toBe('fallback');
  });

  it('renders templates and tidies gaps left by missing variables', () => {
    expect(
      renderTemplate('{title} [{quality}].{ext}', { title: 'Talk', quality: '1080p', ext: 'mp4' }),
    ).toBe('Talk [1080p].mp4');
    expect(renderTemplate('{title} [{quality}].{ext}', { title: 'Talk', ext: 'mp4' })).toBe(
      'Talk.mp4',
    );
    expect(renderTemplate('{title} {nope}', { title: 'Talk' })).toBe('Talk');
  });

  it('builds the full relative path with folders', () => {
    const name = buildFilename({
      candidate: candidate({
        title: 'How to Build a Startup | Tech Conference 2026',
        pageUrl: 'https://www.vimeo.com/watch',
      }),
      variant: variant({ resolution: { width: 1920, height: 1080 } }),
      template: '{title} [{quality}].{ext}',
      folders: { baseFolder: 'MediaGrab', siteFolders: true },
      now: new Date('2026-09-07T10:30:00'),
    });
    // The pipe separator becomes a space and the run is collapsed.
    expect(name).toBe(
      'MediaGrab/vimeo.com/How to Build a Startup Tech Conference 2026 [1080p].mp4',
    );
  });

  it('appends the extension when the template omits it', () => {
    const name = buildFilename({
      candidate: candidate({ title: 'Clip' }),
      template: '{title}',
      now: new Date('2026-09-07T10:30:00'),
    });
    expect(name).toBe('Clip.mp4');
  });

  it('refuses to let a hostile page title escape the download folder', () => {
    const name = buildFilename({
      candidate: candidate({ title: '../../../../Library/LaunchAgents/evil' }),
      template: '{title}.{ext}',
      folders: { baseFolder: 'MediaGrab' },
      now: new Date('2026-09-07T10:30:00'),
    });
    expect(name.startsWith('MediaGrab/')).toBe(true);
    expect(name).not.toContain('..');
    expect(name.split('/')).toHaveLength(2);
  });

  it('trims the site name a CMS appends to the page title, and nothing else', () => {
    expect(cleanTitle('How to Build a Startup | Tech Conference', 'techconference.example')).toBe(
      'How to Build a Startup',
    );
    expect(cleanTitle('Long documentary about the sea - BBC', 'BBC')).toBe(
      'Long documentary about the sea',
    );
    // Without knowing the site, a trailing fragment is part of the title.
    expect(cleanTitle('How to Build a Startup | Tech Conference 2026')).toBe(
      'How to Build a Startup | Tech Conference 2026',
    );
    expect(cleanTitle('A - B')).toBe('A - B');
  });
});

describe('poster back-fill', () => {
  const POSTER = 'https://cdn.example/poster.jpg';

  it('gives a network-found manifest the poster from a player on the same page', () => {
    const withPoster = candidate({ id: 'dom', source: 'dom-element', posterUrl: POSTER });
    const manifest = candidate({ id: 'hls', source: 'network', protocol: 'hls' });

    const [, filled] = backfillPosters([withPoster, manifest]);
    expect(filled?.posterUrl).toBe(POSTER);
  });

  it('never overwrites a poster a candidate already has', () => {
    const own = 'https://cdn.example/own.jpg';
    const [first] = backfillPosters(
      [candidate({ id: 'a', posterUrl: own }), candidate({ id: 'b', posterUrl: POSTER })],
      { pagePoster: 'https://cdn.example/page.jpg' },
    );
    expect(first?.posterUrl).toBe(own);
  });

  it('falls back to the page-level poster when no candidate has one', () => {
    const page = 'https://cdn.example/og.jpg';
    const [filled] = backfillPosters([candidate({ id: 'hls', protocol: 'hls' })], {
      pagePoster: page,
    });
    expect(filled?.posterUrl).toBe(page);
  });

  it('does not lend a poster across different pages', () => {
    const a = candidate({ id: 'a', pageUrl: 'https://one.example/x', posterUrl: POSTER });
    const b = candidate({ id: 'b', pageUrl: 'https://two.example/y' });
    const [, second] = backfillPosters([a, b]);
    expect(second?.posterUrl).toBeUndefined();
  });

  it('rejects data URLs and junk, which are usually 1px placeholders', () => {
    const [filled] = backfillPosters([candidate({ id: 'a' })], {
      pagePoster: 'data:image/gif;base64,R0lGOD',
    });
    expect(filled?.posterUrl).toBeUndefined();
    expect(choosePagePoster(['', undefined, 'not-a-url', POSTER])).toBe(POSTER);
  });

  it('leaves images and subtitles alone', () => {
    const [image] = backfillPosters([candidate({ id: 'i', kind: 'image' })], {
      pagePoster: POSTER,
    });
    expect(image?.posterUrl).toBeUndefined();
  });
});
