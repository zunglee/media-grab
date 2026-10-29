/**
 * Regression tests for the media-rules audit (B1-B21, A2, A7, A13, AD1).
 * Inputs are the ones the audit's proof scripts used, so a failure here means
 * a proven bug is back.
 */
import { describe, expect, it } from 'vitest';
import type { MediaCandidate, MediaVariant, Resolution } from '../../src/core/types.ts';
import { dedupe, nearKey, sameRenditionUrl } from '../../src/media/dedupe.ts';
import {
  bucketSize,
  fingerprintCandidate,
  isVolatileParam,
  normalizeUrl,
  registrableDomain,
} from '../../src/media/fingerprint.ts';
import {
  classifyMediaUrl,
  codecFamily,
  fileExtensionFor,
  guessFormat,
  isAudioCodec,
  tracksFromCodecs,
} from '../../src/media/format.ts';
import { buildFilename, cleanTitle, sanitizeSegment } from '../../src/media/naming.ts';
import { choosePagePoster } from '../../src/media/poster.ts';
import {
  formatBytes,
  qualityLabel,
  recommend,
  resolutionLabel,
  videoLadder,
} from '../../src/media/quality.ts';
import { DISPLAY_THRESHOLD, qualityScore, scoreCandidate } from '../../src/media/score.ts';

const PAGE = 'https://site.example/watch';
const NOW = new Date('2026-09-07T10:30:00');

/** A candidate whose id is computed the way detection computes it. */
function candidate(url: string, overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  const base: MediaCandidate = {
    id: '',
    url,
    pageUrl: PAGE,
    kind: 'video',
    protocol: 'progressive',
    format: 'mp4',
    source: 'network',
    seenAt: 1,
    tracks: { video: true, audio: true },
    ...overrides,
  };
  return { ...base, id: overrides.id ?? fingerprintCandidate(base) };
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

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
const hasLoneSurrogate = (text: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

describe('B1 file names keep their extension and fit the filesystem', () => {
  it('never loses the extension to a long title (proof M3)', () => {
    const title =
      'Breaking: Very long headline about a thing that happened today in the city council meeting and more words here end';
    const name = buildFilename({
      candidate: candidate('https://cdn.example/v.mp4', {
        title,
        resolution: { width: 1920, height: 1080 },
      }),
      extension: 'mp4',
      now: NOW,
    });
    expect(name.endsWith(' [1080p].mp4')).toBe(true);
    expect(name.startsWith('Breaking Very long headline')).toBe(true);
    expect(utf8Bytes(name)).toBeLessThanOrEqual(120);
  });

  it.each([107, 108, 109, 200])('keeps ".mp4" with a %i-character title (proof p-dup)', (n) => {
    const name = buildFilename({
      candidate: candidate('https://cdn.example/v/manifest.mpd', { title: 'x'.repeat(n) }),
      variant: variant({ resolution: { width: 1920, height: 1080 } }),
      extension: 'mp4',
      now: NOW,
    });
    expect(name.endsWith('x [1080p].mp4')).toBe(true);
    expect(utf8Bytes(name)).toBeLessThanOrEqual(120);
  });

  it('cuts at code-point boundaries, never inside an emoji (proof M4)', () => {
    const segment = sanitizeSegment(`${'a'.repeat(119)}\u{1F600}tail`);
    expect(hasLoneSurrogate(segment)).toBe(false);
    const name = buildFilename({
      candidate: candidate('https://cdn.example/v.mp4', { title: `${'a'.repeat(114)}\u{1F600}` }),
      template: '{title}.{ext}',
      now: NOW,
    });
    expect(hasLoneSurrogate(name)).toBe(false);
    expect(name.endsWith('.mp4')).toBe(true);
  });

  it('caps in UTF-8 bytes, so a Japanese title fits too', () => {
    const name = buildFilename({
      candidate: candidate('https://cdn.example/v.mp4', { title: '日本語のタイトル'.repeat(20) }),
      template: '{title}.{ext}',
      now: NOW,
    });
    expect(utf8Bytes(name)).toBeLessThanOrEqual(120);
    expect(name.endsWith('.mp4')).toBe(true);
  });

  it('escapes Windows device names, with or without an extension', () => {
    const named = (title: string) =>
      buildFilename({
        candidate: candidate('https://cdn.example/v.mp4', { title }),
        template: '{title}.{ext}',
        now: NOW,
      });
    expect(named('CON')).toBe('_CON.mp4');
    expect(named('nul ')).toBe('_nul.mp4');
    expect(named('com¹')).toBe('_com¹.mp4');
    expect(named('LPT0')).toBe('_LPT0.mp4');
    expect(named('aux.backup')).toBe('_aux.backup.mp4');
    expect(named('CONTACT')).toBe('CONTACT.mp4');
  });

  it('removes trailing dots and spaces, path separators and lone surrogates', () => {
    const named = (title: string) =>
      buildFilename({
        candidate: candidate('https://cdn.example/v.mp4', { title }),
        template: '{title}.{ext}',
        now: NOW,
      });
    expect(named('Clip... ')).toBe('Clip.mp4');
    expect(named('a/b\\c')).toBe('a b c.mp4');
    expect(named(`bad\uD800name`)).toBe('bad name.mp4');
  });

  it('shortens the stem, never a folder or the extension, to honour the path cap', () => {
    const name = buildFilename({
      candidate: candidate('https://cdn.example/v.mp4', { title: 'y'.repeat(110) }),
      template: '{title}.{ext}',
      folders: { baseFolder: Array.from({ length: 8 }, () => 'f'.repeat(20)).join('/') },
      now: NOW,
    });
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.startsWith(`${'f'.repeat(20)}/`)).toBe(true);
    expect(name.endsWith('.mp4')).toBe(true);
  });
});

describe('B8 / A13 / A7 identity and the mirror pass', () => {
  it('keeps two videos behind one script apart (proof M1)', () => {
    const a = candidate('https://site.example/get_video.php?id=111', { title: 'Cats' });
    const b = candidate('https://site.example/get_video.php?id=222', { title: 'Dogs' });
    expect(nearKey(a)).not.toBe(nearKey(b));
    expect(dedupe([a, b]).map((c) => c.title)).toEqual(['Cats', 'Dogs']);
  });

  it('keeps them apart even when their durations match', () => {
    const a = candidate('https://site.example/get_video.php?id=111', { duration: 60 });
    const b = candidate('https://site.example/get_video.php?id=222', { duration: 60 });
    expect(dedupe([a, b])).toHaveLength(2);
  });

  it('merges one asset served from two mirror hosts when the media matches', () => {
    const a = candidate('https://r3.cdn.example/v/clip.mp4?id=9&token=A', { duration: 61.2 });
    const b = candidate('http://r7.cdn.example/v/clip.mp4?id=9&token=B', { duration: 60.8 });
    expect(dedupe([a, b])).toHaveLength(1);
  });

  it('does not merge mirror hosts without evidence', () => {
    const a = candidate('https://r3.cdn.example/v/clip.mp4');
    const b = candidate('https://r7.cdn.example/v/clip.mp4');
    expect(dedupe([a, b])).toHaveLength(2);
  });

  it('gives one <video> the same id before and after its metadata loads (proof flow A)', () => {
    const url = 'https://site.example/media/cat.mp4';
    const pre = candidate(url, { source: 'dom-element', title: 'Cat' });
    const post = candidate(url, {
      source: 'dom-element',
      title: 'Cat',
      duration: 120.2,
      resolution: { width: 1280, height: 720 },
    });
    const net = candidate(url, { sizeBytes: 30_000_000, sizeEstimated: false });
    expect(pre.id).toBe(post.id);
    expect(pre.id).toBe(net.id);
    const [merged, ...rest] = dedupe([pre, post, net]);
    expect(rest).toHaveLength(0);
    expect(merged?.duration).toBe(120.2);
    expect(merged?.sizeBytes).toBe(30_000_000);
  });

  it('treats presigned S3/GCS and LL-HLS parameters as volatile', () => {
    for (const name of ['X-Amz-Signature', 'x-amz-date', 'X-Goog-Credential', '_HLS_msn']) {
      expect(isVolatileParam(name)).toBe(true);
    }
    expect(normalizeUrl('https://b.s3.example/v.mp4?X-Amz-Date=1&X-Amz-Signature=abc')).toBe(
      'https://b.s3.example/v.mp4',
    );
    const reloads = [100, 101, 102].map((msn) =>
      candidate(`https://site.example/live/720p.m3u8?_HLS_msn=${msn}&_HLS_part=0`, {
        protocol: 'hls',
      }),
    );
    expect(new Set(reloads.map((c) => c.id)).size).toBe(1);
  });

  it('finds the registrable domain without the Public Suffix List', () => {
    expect(registrableDomain('r3---sn-ab.googlevideo.com')).toBe('googlevideo.com');
    expect(registrableDomain('www.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('tasty.co')).toBe('tasty.co');
    expect(registrableDomain('192.168.0.10')).toBe('192.168.0.10');
  });
});

describe('B2 same rendition is URL identity, not a shared file name', () => {
  const running = 'https://cdn.example/v/111/1080p/index.m3u8';

  it('does not call a different video with the same file name a duplicate (proof M2)', () => {
    expect(sameRenditionUrl('https://cdn.example/v/222/1080p/index.m3u8', running)).toBe(false);
    expect(sameRenditionUrl('https://cdn.example/v/111/720p/index.m3u8', running)).toBe(false);
  });

  it('does call a re-signed URL of the same rendition a duplicate', () => {
    expect(sameRenditionUrl(`${running}?token=A&Expires=1`, `${running}?token=B#t=3`)).toBe(true);
  });
});

describe('B9 codec strings', () => {
  it('recognises Dolby Vision + E-AC-3 as video and audio (proof M7b)', () => {
    expect(tracksFromCodecs(['dvh1.05.06', 'ec-3'])).toEqual({ video: true, audio: true });
  });

  it.each([
    'avc1.640028',
    'avc3.4d401f',
    'hvc1.1.6.L93.B0',
    'hev1.1.6.L93.B0',
    'dvh1.05.06',
    'dvhe.05.06',
    'vp8',
    'vp09.00.10.08',
    'vp9',
    'av01.0.05M.08',
    'mp4v.20.9',
  ])('%s is video', (codec) => {
    expect(tracksFromCodecs([codec])).toEqual({ video: true, audio: false });
    expect(isAudioCodec(codec)).toBe(false);
  });

  it.each(['ec-3', 'ac-3', 'mp4a.40.2', 'mp4a.40.5', 'opus', 'flac', 'vorbis', 'alac', 'mp3'])(
    '%s is audio',
    (codec) => {
      expect(tracksFromCodecs([codec])).toEqual({ video: false, audio: true });
      expect(isAudioCodec(codec)).toBe(true);
    },
  );

  it('maps Dolby Vision to its base codec and MP3-in-MP4 to mp3', () => {
    expect(codecFamily('dvh1.05.06')).toBe('hevc');
    expect(codecFamily('mp4a.6B')).toBe('mp3');
    expect(codecFamily('mp4a.40.2')).toBe('aac');
    expect(codecFamily('stpp')).toBe('stpp');
  });
});

describe('B10 MIME aliases (proof M8)', () => {
  const ext = (url: string, mime: string) => {
    const guess = guessFormat(url, mime);
    return `${guess.protocol}/${guess.kind}/.${fileExtensionFor(guess.format, guess.kind, mime)}`;
  };

  it('names each container honestly', () => {
    expect(ext('https://rr1.example/videoplayback?itag=251', 'audio/webm')).toBe(
      'progressive/audio/.webm',
    );
    expect(ext('https://cdn.example/stream?id=9', 'audio/mp3')).toBe('progressive/audio/.mp3');
    expect(ext('https://cdn.example/stream?id=9', 'audio/mpeg3')).toBe('progressive/audio/.mp3');
    expect(ext('https://cdn.example/clip?id=9', 'video/x-flv')).toBe('progressive/video/.flv');
    expect(ext('https://cdn.example/clip?id=9', 'video/3gpp')).toBe('progressive/video/.3gp');
    expect(ext('https://cdn.example/clip?id=9', 'video/quicktime')).toBe('progressive/video/.mov');
    expect(ext('https://cdn.example/clip?id=9', 'video/x-matroska')).toBe('progressive/video/.mkv');
  });

  it('treats every mpegurl spelling as HLS, not a progressive audio file', () => {
    expect(guessFormat('https://cdn.example/playlist?id=9', 'audio/x-mpegurl').protocol).toBe(
      'hls',
    );
    expect(guessFormat('https://cdn.example/playlist?id=9', 'audio/mpegurl').protocol).toBe('hls');
  });
});

describe('A2 blob: and data: are never downloadable progressive media', () => {
  it('classifies a page blob with a media type as blob (proof flow D)', () => {
    const guess = guessFormat('blob:https://site.example/6f1c-uuid', 'video/mp4');
    expect(guess.protocol).toBe('blob');
    expect(guess.kind).toBe('video');
    expect(guessFormat('data:video/mp4;base64,AAAA').protocol).toBe('data');
    expect(guessFormat('data:video/mp4;base64,AAAA').kind).toBe('video');
  });

  it('keeps a blob below the display threshold however good it looks (proof blob H)', () => {
    const blob = candidate('blob:https://site.example/1b2c', {
      protocol: 'blob',
      source: 'dom-element',
      duration: 300,
      resolution: { width: 1920, height: 1080 },
      title: 'Watch',
    });
    const { score, reasons } = scoreCandidate(blob);
    expect(score).toBeLessThan(DISPLAY_THRESHOLD);
    expect(reasons.join(' ')).toMatch(/blob URL/);
  });
});

describe('AD1 classifyMediaUrl is the one "is this media" rule', () => {
  it.each([
    'https://cdn.example/v/seg-00042.m4s',
    'https://cdn.example/v/chunk_1.ts',
    'https://cdn.example/v/000123.m4s',
    'https://cdn.example/v/720p/segment3.ts',
    'https://cdn.example/v/segment_3.m4s',
    'https://cdn.example/v/chunk-stream0-00001.m4s',
    'https://cdn.example/v/init.mp4',
    'https://cdn.example/v/v1080/init-stream0.mp4',
    'https://cdn.example/v/frag/12.mp4',
    'https://cdn.example/v/fileSequence12.aac',
    'https://cdn.example/v/track.cmfv',
    'https://cdn.example/v/anything.ts',
  ])('%s is a segment', (url) => {
    expect(classifyMediaUrl(url)?.isSegment).toBe(true);
  });

  it('recognises segments by MIME type and Smooth Streaming shape', () => {
    expect(classifyMediaUrl('https://cdn.example/s?n=4', 'video/mp2t')?.isSegment).toBe(true);
    expect(classifyMediaUrl('https://cdn.example/s?n=4', 'video/iso.segment')?.isSegment).toBe(
      true,
    );
    expect(
      classifyMediaUrl(
        'https://cdn.example/v.ism/QualityLevels(3000000)/Fragments(video=0)',
        'video/mp4',
      )?.isSegment,
    ).toBe(true);
  });

  it.each([
    'https://cdn.example/videos/lecture.mp4',
    'https://cdn.example/videos/chunky-monkey.mp4',
    'https://cdn.example/videos/initial-d.mp4',
    'https://cdn.example/v/master.m3u8',
    'https://cdn.example/v/manifest.mpd',
    'https://cdn.example/podcast/episode-12.mp3',
  ])('%s is a whole file or a manifest', (url) => {
    const media = classifyMediaUrl(url);
    expect(media).not.toBeNull();
    expect(media?.isSegment).toBe(false);
  });

  it('returns kind, protocol and format, and null for what is not media', () => {
    expect(classifyMediaUrl('https://cdn.example/v/master.m3u8')).toEqual({
      kind: 'video',
      protocol: 'hls',
      format: 'ts',
      isSegment: false,
    });
    expect(classifyMediaUrl('https://cdn.example/subs/en.vtt')?.kind).toBe('subtitle');
    expect(classifyMediaUrl('https://cdn.example/poster.jpg')).toBeNull();
    expect(classifyMediaUrl('https://cdn.example/app.js')).toBeNull();
    expect(classifyMediaUrl('https://cdn.example/api/data', 'application/json')).toBeNull();
    expect(classifyMediaUrl('blob:https://site.example/x', 'video/mp4')?.protocol).toBe('blob');
  });
});

describe('B17 one resolution label rule (proof M5)', () => {
  const label = (width: number, height: number) => resolutionLabel({ width, height });

  it('labels portrait by its short side and letterbox by its width', () => {
    expect(label(1080, 1920)).toBe('1080p');
    expect(label(720, 1280)).toBe('720p');
    expect(label(1920, 800)).toBe('1080p');
    expect(label(3840, 1600)).toBe('4K');
    expect(label(1920, 1080)).toBe('1080p');
    expect(label(1918, 1076)).toBe('1080p');
    expect(resolutionLabel({ width: 1280, height: 720 }, 59.94)).toBe('720p60');
  });

  it('is what qualityLabel and file names use', () => {
    const portrait: Resolution = { width: 1080, height: 1920 };
    expect(qualityLabel(variant({ resolution: portrait }))).toBe('1080p');
    const name = buildFilename({
      candidate: candidate('https://cdn.example/v.mp4', { title: 'Reel', resolution: portrait }),
      now: NOW,
    });
    expect(name).toBe('Reel [1080p].mp4');
  });
});

describe('B18 renditions without a resolution stay separate (proof M6)', () => {
  it('keeps one ladder entry per bitrate', () => {
    const v = (id: string, bandwidth: number) =>
      variant({ id, url: id, bandwidth, codecs: ['avc1.64001f', 'mp4a.40.2'] });
    const ladder = videoLadder([v('lo', 400_000), v('mid', 1_500_000), v('hi', 5_000_000)]);
    expect(ladder.map((entry) => entry.id)).toEqual(['hi', 'mid', 'lo']);
    expect(ladder.map(qualityLabel)).toEqual(['5.0 Mbps', '1.5 Mbps', '400 kbps']);
  });
});

describe('B19 resolution dominates codec between rungs (proof M10)', () => {
  const dash = (id: string, height: number, bandwidth: number, codec: string) =>
    variant({
      id,
      url: id,
      protocol: 'dash',
      format: 'mp4',
      bandwidth,
      resolution: { width: Math.round((height * 16) / 9), height },
      codecs: [codec],
      tracks: { video: true, audio: false },
    });

  it('picks 2160p H.264 over 1440p AV1 as "best"', () => {
    const [best] = recommend(
      candidate('https://x.example/m.mpd', {
        protocol: 'dash',
        variants: [
          dash('1440-av1', 1440, 13_000_000, 'av01.0.12M.08'),
          dash('2160-avc', 2160, 20_000_000, 'avc1.640033'),
        ],
      }),
    );
    expect(best?.variant.id).toBe('2160-avc');
  });

  it('keeps climbing with height up to 8K instead of plateauing near 1614px', () => {
    const heights = [720, 1080, 1440, 1614, 2160, 4320];
    const scores = heights.map((height) => qualityScore({ height }));
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1] ?? 0);
    }
  });

  it('never lets the codec spread outweigh the smallest rung step', () => {
    const best = qualityScore({ height: 1080, codecs: ['av01.0.08M.08'] });
    const worst = qualityScore({ height: 1440, codecs: ['mp4v.20.9'] });
    expect(worst).toBeGreaterThan(best);
  });
});

describe('B20 ad paths are whole segments or ad hosts (proof M9)', () => {
  const adReason = (url: string) =>
    scoreCandidate(candidate(url, { sizeBytes: 80_000_000, sizeEstimated: false }))
      .reasons.join(' ')
      .includes('advertising');

  it('does not penalise a title that contains an ad word', () => {
    expect(adReason('https://cdn.example/videos/pixel-9-pro-review.mp4')).toBe(false);
    expect(adReason('https://cdn.example/videos/vast-landscapes.mp4')).toBe(false);
    expect(adReason('https://cdn.example/videos/analytics-explained.mp4')).toBe(false);
  });

  it('still penalises ad directories, ad files and ad-serving hosts', () => {
    expect(adReason('https://cdn.example/ads/preroll.mp4')).toBe(true);
    expect(adReason('https://cdn.example/v/pre-roll.mp4')).toBe(true);
    expect(adReason('https://cdn.example/track/pixel.gif')).toBe(true);
    expect(adReason('https://s0.2mdn.net/videoplayback/123/clip.mp4')).toBe(true);
  });
});

describe('B21 cleanTitle strips only the site name (proof X5)', () => {
  it('keeps a title whose last part is not the site', () => {
    expect(cleanTitle('Taylor Swift - Anti-Hero', 'https://www.youtube.com/watch?v=1')).toBe(
      'Taylor Swift - Anti-Hero',
    );
    expect(cleanTitle('Official Trailer 2024 - Dune', 'https://www.imdb.com/title/x')).toBe(
      'Official Trailer 2024 - Dune',
    );
    expect(cleanTitle('Taylor Swift - Anti-Hero')).toBe('Taylor Swift - Anti-Hero');
  });

  it('strips the site name, matched against the domain label', () => {
    expect(cleanTitle('How to Cook Rice - Part 2 | Tasty', 'https://tasty.co/recipe/rice')).toBe(
      'How to Cook Rice - Part 2',
    );
    expect(cleanTitle('Clip - YouTube', 'https://www.youtube.com/watch?v=1')).toBe('Clip');
    expect(cleanTitle('Sea life — BBC', 'www.bbc.co.uk')).toBe('Sea life');
    expect(cleanTitle('Sea life | You Tube', 'youtube.com')).toBe('Sea life');
  });

  it('cleans the page title fallback in file names, never the media own title', () => {
    const fromPage = buildFilename({
      candidate: candidate('https://cdn.example/v.mp4', {
        pageUrl: 'https://www.youtube.com/watch?v=1',
        pageTitle: 'Clip - YouTube',
      }),
      template: '{title}.{ext}',
      now: NOW,
    });
    expect(fromPage).toBe('Clip.mp4');
    const own = buildFilename({
      candidate: candidate('https://cdn.example/v.mp4', {
        pageUrl: 'https://www.youtube.com/watch?v=1',
        pageTitle: 'Other - YouTube',
        title: 'Clip - YouTube',
      }),
      template: '{title}.{ext}',
      now: NOW,
    });
    expect(own).toBe('Clip - YouTube.mp4');
  });
});

describe('poster URLs are judged as URLs, not by length', () => {
  it('accepts a short absolute URL and rejects things that are not one', () => {
    expect(choosePagePoster(['http://', '/relative.jpg', 'https://a.co/p'])).toBe('https://a.co/p');
  });
});

describe('NaN and negative durations never produce negative totals', () => {
  it('ignores non-finite and negative inputs', () => {
    expect(qualityScore({ height: Number.NaN, bitrate: -1, audioBitrate: Number.NaN })).toBe(0);
    expect(bucketSize(Number.NaN)).toBe(0);
    expect(formatBytes(-5)).toBe('unknown size');

    const reasons = scoreCandidate(
      candidate('https://cdn.example/v.mp4', { duration: Number.NaN }),
    ).reasons;
    expect(reasons.join(' ')).not.toMatch(/substantial|bumper|short/);

    const ladder = candidate('https://cdn.example/m.m3u8', {
      protocol: 'hls',
      duration: -30,
      variants: [variant({ bandwidth: 1_000_000, resolution: { width: 1280, height: 720 } })],
    });
    for (const recommendation of recommend(ladder)) {
      expect(recommendation.sizeBytes ?? 0).toBeGreaterThanOrEqual(0);
    }
    expect(scoreCandidate(ladder).reasons.join(' ')).not.toMatch(/under 50 KB/);
  });
});
