import { describe, expect, it } from 'vitest';
import { parseAttributeList, parseByteRange } from '../../src/manifests/hls/attributes.ts';
import { drmSystemFor, isMasterPlaylist, parseHlsPlaylist } from '../../src/manifests/hls/parse.ts';
import { buildHlsSegmentPlan, hlsContainer } from '../../src/manifests/hls/segments.ts';

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en/index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Hindi",LANGUAGE="hi",DEFAULT=NO,AUTOSELECT=YES,URI="audio/hi/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",FORCED=NO,URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5200000,AVERAGE-BANDWIDTH=4800000,RESOLUTION=1920x1080,FRAME-RATE=29.970,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac",SUBTITLES="subs"
v1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3100000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac"
v720/index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=180000,RESOLUTION=640x360,URI="iframe/index.m3u8"
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000,
seg-1.m4s
#EXTINF:6.000,
seg-2.m4s
#EXTINF:3.500,
seg-3.m4s
#EXT-X-ENDLIST
`;

describe('HLS attribute lists', () => {
  it('does not split on commas inside a quoted value', () => {
    const attrs = parseAttributeList(
      'BANDWIDTH=5200000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080',
    );
    expect(attrs.get('CODECS')).toBe('avc1.640028,mp4a.40.2');
    expect(attrs.get('BANDWIDTH')).toBe('5200000');
    expect(attrs.get('RESOLUTION')).toBe('1920x1080');
  });

  it('uppercases attribute names and tolerates spaces', () => {
    const attrs = parseAttributeList('type=AUDIO, group-id="aac"');
    expect(attrs.get('TYPE')).toBe('AUDIO');
    expect(attrs.get('GROUP-ID')).toBe('aac');
  });

  it('parses byte ranges with and without an offset', () => {
    expect(parseByteRange('1024@512')).toEqual({ length: 1024, offset: 512 });
    expect(parseByteRange('2048')).toEqual({ length: 2048 });
    expect(parseByteRange('nonsense')).toBeUndefined();
  });
});

describe('HLS master playlists', () => {
  it('is recognised as a master playlist', () => {
    expect(isMasterPlaylist(MASTER)).toBe(true);
    expect(isMasterPlaylist(MEDIA)).toBe(false);
  });

  it('parses variants with their resolution, codecs and groups', () => {
    const playlist = parseHlsPlaylist(MASTER);
    if (playlist.kind !== 'master') throw new Error('expected a master playlist');

    expect(playlist.variants).toHaveLength(2);
    const [first] = playlist.variants;
    expect(first?.uri).toBe('v1080/index.m3u8');
    expect(first?.bandwidth).toBe(5_200_000);
    expect(first?.averageBandwidth).toBe(4_800_000);
    expect(first?.resolution).toEqual({ width: 1920, height: 1080 });
    expect(first?.frameRate).toBeCloseTo(29.97);
    expect(first?.codecs).toEqual(['avc1.640028', 'mp4a.40.2']);
    expect(first?.audioGroupId).toBe('aac');
    expect(first?.subtitleGroupId).toBe('subs');
  });

  it('ignores I-FRAME trick-play streams', () => {
    const playlist = parseHlsPlaylist(MASTER);
    if (playlist.kind !== 'master') throw new Error('expected a master playlist');
    expect(playlist.variants.some((variant) => variant.uri.includes('iframe'))).toBe(false);
  });

  it('collects audio and subtitle renditions', () => {
    const playlist = parseHlsPlaylist(MASTER);
    if (playlist.kind !== 'master') throw new Error('expected a master playlist');

    const audio = playlist.renditions.filter((rendition) => rendition.type === 'AUDIO');
    expect(audio).toHaveLength(2);
    expect(audio[0]?.default).toBe(true);
    expect(audio[1]?.language).toBe('hi');
    expect(playlist.renditions.filter((r) => r.type === 'SUBTITLES')).toHaveLength(1);
  });

  it('rejects anything that is not a playlist', () => {
    expect(() => parseHlsPlaylist('<html></html>')).toThrow(/EXTM3U/);
  });
});

describe('HLS media playlists', () => {
  it('parses segments, duration and the init segment', () => {
    const playlist = parseHlsPlaylist(MEDIA);
    if (playlist.kind !== 'media') throw new Error('expected a media playlist');

    expect(playlist.segments).toHaveLength(3);
    expect(playlist.totalDuration).toBeCloseTo(15.5);
    expect(playlist.live).toBe(false);
    expect(playlist.segments[0]?.init?.uri).toBe('init.mp4');
  });

  it('treats a playlist without ENDLIST as live', () => {
    const live = MEDIA.replace('#EXT-X-ENDLIST\n', '').replace('#EXT-X-PLAYLIST-TYPE:VOD\n', '');
    const playlist = parseHlsPlaylist(live);
    if (playlist.kind !== 'media') throw new Error('expected a media playlist');
    expect(playlist.live).toBe(true);
  });

  it('flags DRM key formats but not plain AES-128', () => {
    expect(drmSystemFor('SAMPLE-AES', 'com.apple.streamingkeydelivery')).toBe('FairPlay');
    expect(drmSystemFor('AES-128', 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed')).toBe(
      'Widevine',
    );
    expect(drmSystemFor('AES-128', 'identity')).toBeNull();
  });

  it('records AES-128 as encrypted without calling it DRM', () => {
    const encrypted = MEDIA.replace(
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key",IV=0x00\n#EXT-X-MAP:URI="init.mp4"',
    );
    const playlist = parseHlsPlaylist(encrypted);
    if (playlist.kind !== 'media') throw new Error('expected a media playlist');
    expect(playlist.encrypted).toBe(true);
    expect(playlist.drm).toBe(false);
  });

  it('marks Widevine-keyed playlists as DRM', () => {
    const drm = MEDIA.replace(
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="skd://x"',
    );
    const playlist = parseHlsPlaylist(drm);
    if (playlist.kind !== 'media') throw new Error('expected a media playlist');
    expect(playlist.drm).toBe(true);
    expect(playlist.drmSystems).toContain('Widevine');
  });
});

describe('HLS segment plans', () => {
  it('resolves segment URLs against the playlist URL and carries the init segment', () => {
    const playlist = parseHlsPlaylist(MEDIA);
    if (playlist.kind !== 'media') throw new Error('expected a media playlist');

    const plan = buildHlsSegmentPlan(playlist, 'https://cdn.example/v/1080/index.m3u8', 5_000_000);
    expect(plan.init?.url).toBe('https://cdn.example/v/1080/init.mp4');
    expect(plan.segments[0]?.url).toBe('https://cdn.example/v/1080/seg-1.m4s');
    expect(plan.segments).toHaveLength(3);
    expect(plan.totalDuration).toBeCloseTo(15.5);
    // 5 Mbit/s over 15.5s
    expect(plan.estimatedBytes).toBe(Math.round((5_000_000 / 8) * 15.5));
  });

  it('turns byte-range segments into Range headers that continue where the last one ended', () => {
    const ranged = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000@0
all.ts
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000
all.ts
#EXT-X-ENDLIST
`;
    const playlist = parseHlsPlaylist(ranged);
    if (playlist.kind !== 'media') throw new Error('expected a media playlist');

    const plan = buildHlsSegmentPlan(playlist, 'https://cdn.example/all.m3u8');
    expect(plan.segments[0]?.range).toBe('bytes=0-999');
    expect(plan.segments[1]?.range).toBe('bytes=1000-1999');
  });
});

describe('pass 2: HLS plans refuse rather than cut or corrupt', () => {
  const media = (body: string) => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${body}\n#EXT-X-ENDLIST\n`,
    );
    if (playlist.kind !== 'media') throw new Error('expected a media playlist');
    return playlist;
  };

  it('regression: refuses a stream whose init segment changes part-way (ad insertion)', () => {
    const playlist = media(
      [
        '#EXT-X-MAP:URI="content_init.mp4"',
        '#EXTINF:6,',
        'c1.m4s',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-MAP:URI="ad_init.mp4"',
        '#EXTINF:6,',
        'ad1.m4s',
      ].join('\n'),
    );
    expect(() => buildHlsSegmentPlan(playlist, 'https://cdn.example/v/index.m3u8')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_MANIFEST' }),
    );
  });

  it('regression: refuses a stream too long to assemble instead of silently cutting it', () => {
    const body = Array.from({ length: 20_001 }, (_unused, i) => `#EXTINF:1,\ns${i}.ts`).join('\n');
    expect(() => buildHlsSegmentPlan(media(body), 'https://cdn.example/v/index.m3u8')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_MANIFEST' }),
    );
  });

  it('skips EXT-X-GAP segments instead of failing the download on them', () => {
    const playlist = media(
      '#EXTINF:4,\na.ts\n#EXT-X-GAP\n#EXTINF:4,\nmissing.ts\n#EXTINF:4,\nb.ts',
    );
    const plan = buildHlsSegmentPlan(playlist, 'https://cdn.example/v/index.m3u8');
    expect(plan.segments.map((segment) => segment.url.split('/').pop())).toEqual(['a.ts', 'b.ts']);
    expect(plan.totalDuration).toBe(8);
  });

  it('never lets an unknown EXTINF duration make the total negative', () => {
    expect(media('#EXTINF:-1,\na.ts\n#EXTINF:4,\nb.ts').totalDuration).toBe(4);
  });

  it('reports a non-playlist as an unsupported manifest, not an internal error', () => {
    expect(() => parseHlsPlaylist('<html></html>')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_MANIFEST' }),
    );
  });

  it('regression: says what the joined segments are, so fMP4 is not saved as .ts', () => {
    expect(hlsContainer(media('#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\n1.m4s'))).toBe('mp4');
    expect(hlsContainer(media('#EXTINF:6,\naudio-1.aac'))).toBe('aac');
    expect(hlsContainer(media('#EXTINF:6,\n1.ts'))).toBe('ts');
  });
});

describe('pass 2 re-audit: init and byte-range edge cases', () => {
  const media = (body: string) => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${body}\n#EXT-X-ENDLIST\n`,
    );
    if (playlist.kind !== 'media') throw new Error('expected a media playlist');
    return playlist;
  };
  const URL_ = 'https://cdn.example/v/index.m3u8';

  it('refuses MPEG-TS segments followed by fMP4 segments with an init', () => {
    const playlist = media('#EXTINF:6,\na.ts\n#EXT-X-MAP:URI="ad-init.mp4"\n#EXTINF:6,\nad1.m4s');
    expect(() => buildHlsSegmentPlan(playlist, URL_)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_MANIFEST' }),
    );
  });

  it('treats one init written two ways as one init', () => {
    const playlist = media(
      [
        '#EXT-X-MAP:URI="init.mp4",BYTERANGE="600"',
        '#EXTINF:6,',
        '1.m4s',
        '#EXT-X-MAP:URI="https://cdn.example/v/init.mp4",BYTERANGE="600@0"',
        '#EXTINF:6,',
        '2.m4s',
      ].join('\n'),
    );
    expect(buildHlsSegmentPlan(playlist, URL_).init?.range).toBe('bytes=0-599');
  });

  it('continues byte ranges through a gap', () => {
    const playlist = media(
      [
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:1000@0',
        'all.ts',
        '#EXT-X-GAP',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:1000',
        'all.ts',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:1000',
        'all.ts',
      ].join('\n'),
    );
    const ranges = buildHlsSegmentPlan(playlist, URL_).segments.map((segment) => segment.range);
    expect(ranges).toEqual(['bytes=0-999', 'bytes=2000-2999']);
  });

  it('knows packed MP3 audio', () => {
    expect(hlsContainer(media('#EXTINF:6,\npart-1.mp3'))).toBe('mp3');
  });
});
