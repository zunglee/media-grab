import { describe, expect, it } from 'vitest';
import { ErrorCode, MediaGrabError } from '../../src/core/errors.ts';
import { parseFrameRate, parseIsoDuration } from '../../src/manifests/dash/duration.ts';
import { looksLikeDash, parseDashManifest } from '../../src/manifests/dash/parse.ts';
import { buildSegmentPlan, expandTemplate } from '../../src/manifests/dash/segments.ts';
import { attr, childrenNamed, firstChildNamed, parseXml } from '../../src/manifests/dash/xml.ts';

const MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10M30S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <BaseURL>https://cdn.example/media/</BaseURL>
  <Period id="p0" duration="PT10M30S">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate media="$RepresentationID$/seg-$Number%05d$.m4s" initialization="$RepresentationID$/init.mp4" timescale="1000" duration="4000" startNumber="1"/>
      <Representation id="v1080" bandwidth="4800000" width="1920" height="1080" frameRate="30000/1001" codecs="avc1.640028"/>
      <Representation id="v720" bandwidth="2400000" width="1280" height="720" frameRate="30" codecs="avc1.4d401f"/>
    </AdaptationSet>
    <AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" lang="en">
      <SegmentTemplate media="$RepresentationID$/a-$Number$.m4s" initialization="$RepresentationID$/init.mp4" timescale="1000" duration="4000" startNumber="1"/>
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
`;

/** Parse an MPD and plan its first representation the way plan-builder.ts does. */
function firstRepresentation(text: string, url = 'https://cdn.example/v/manifest.mpd') {
  const manifest = parseDashManifest(text, url);
  const period = manifest.periods[0];
  const rep = period?.representations[0];
  if (!period || !rep) throw new Error('fixture has no representation');
  const plan = buildSegmentPlan(rep, { periodDuration: period.duration, live: manifest.live });
  return { manifest, period, rep, plan };
}

function fileNames(segments: Array<{ url: string }>): string[] {
  return segments.map((segment) => segment.url.split('/').pop() ?? '');
}

function errorCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof MediaGrabError ? error.code : `not a MediaGrabError: ${error}`;
  }
  return 'did not throw';
}

const DRM_MPD = MPD.replace(
  '<AdaptationSet id="1" contentType="video" mimeType="video/mp4" segmentAlignment="true">',
  `<AdaptationSet id="1" contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" value="Widevine"/>`,
);

describe('XML reader', () => {
  it('parses elements, attributes, text and self-closing tags', () => {
    const root = parseXml('<a x="1"><b>text</b><c y="2"/></a>');
    expect(root.localName).toBe('a');
    expect(attr(root, 'x')).toBe('1');
    expect(firstChildNamed(root, 'b')?.text).toBe('text');
    expect(attr(firstChildNamed(root, 'c') as never, 'y')).toBe('2');
  });

  it('strips namespace prefixes for lookups', () => {
    const root = parseXml(
      '<mpd:MPD xmlns:mpd="urn:x"><mpd:Period cenc:default_KID="k" xmlns:cenc="urn:y"/></mpd:MPD>',
    );
    expect(root.localName).toBe('MPD');
    const period = firstChildNamed(root, 'Period');
    expect(period).toBeDefined();
    expect(attr(period as never, 'default_KID')).toBe('k');
  });

  it('skips comments, CDATA and the XML declaration', () => {
    const root = parseXml(
      '<?xml version="1.0"?><a><!-- note --><b><![CDATA[raw <stuff>]]></b></a>',
    );
    expect(firstChildNamed(root, 'b')?.text).toBe('raw <stuff>');
  });

  it('ignores a > inside a quoted attribute value', () => {
    const root = parseXml('<a title="x > y"><b/></a>');
    expect(attr(root, 'title')).toBe('x > y');
    expect(childrenNamed(root, 'b')).toHaveLength(1);
  });

  it('refuses DOCTYPE declarations (XXE surface)', () => {
    expect(() => parseXml('<!DOCTYPE foo SYSTEM "file:///etc/passwd"><a/>')).toThrow(/DOCTYPE/);
  });

  it('rejects unbalanced documents rather than guessing', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
    expect(() => parseXml('<a></a><b></b>')).toThrow(/more than one root/);
  });

  it('decodes entities', () => {
    const root = parseXml('<a t="a&amp;b&#65;&#x42;">x&lt;y</a>');
    expect(attr(root, 't')).toBe('a&bAB');
    expect(root.text).toBe('x<y');
  });

  it('reports unreadable XML as UNSUPPORTED_MANIFEST, not an internal error (B22)', () => {
    expect(errorCodeOf(() => parseXml('<!DOCTYPE x><MPD/>'))).toBe(ErrorCode.UNSUPPORTED_MANIFEST);
    expect(errorCodeOf(() => parseXml('<MPD a="&#x110000;"/>'))).toBe(
      ErrorCode.UNSUPPORTED_MANIFEST,
    );
    expect(errorCodeOf(() => parseXml('<MPD a="&#0;"/>'))).toBe(ErrorCode.UNSUPPORTED_MANIFEST);
    expect(errorCodeOf(() => parseXml('<a></a><b></b>'))).toBe(ErrorCode.UNSUPPORTED_MANIFEST);
    expect(errorCodeOf(() => parseDashManifest('<!DOCTYPE x><MPD/>', 'https://x/m.mpd'))).toBe(
      ErrorCode.UNSUPPORTED_MANIFEST,
    );
  });
});

describe('ISO 8601 durations', () => {
  it('parses the forms MPDs actually use', () => {
    expect(parseIsoDuration('PT10M30S')).toBe(630);
    expect(parseIsoDuration('PT1H2M3.5S')).toBeCloseTo(3723.5);
    expect(parseIsoDuration('P1DT2H')).toBe(93_600);
    expect(parseIsoDuration('PT2S')).toBe(2);
  });

  it('returns undefined for years, months and nonsense', () => {
    expect(parseIsoDuration('P1Y')).toBeUndefined();
    expect(parseIsoDuration('P3M')).toBeUndefined();
    expect(parseIsoDuration('P0Y1M0DT1S')).toBeUndefined();
    expect(parseIsoDuration('10 minutes')).toBeUndefined();
    expect(parseIsoDuration('PT')).toBeUndefined();
    expect(parseIsoDuration(undefined)).toBeUndefined();
  });

  it('accepts zero years and months, which some packagers always write (B5)', () => {
    expect(parseIsoDuration('P0Y0M0DT0H3M30.000S')).toBe(210);

    const zeroYearsMpd = `<MPD type="static" mediaPresentationDuration="P0Y0M0DT0H0M30.000S"><Period>
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" duration="2000" media="$Number$.m4s" initialization="init.mp4"/>
<Representation id="v" bandwidth="1000000"/></AdaptationSet></Period></MPD>`;
    const { period, plan } = firstRepresentation(zeroYearsMpd);
    expect(period.duration).toBe(30);
    expect(plan.segments).toHaveLength(15);
  });

  it('parses fractional frame rates', () => {
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('25')).toBe(25);
    expect(parseFrameRate('30/0')).toBeUndefined();
  });
});

describe('MPD parsing', () => {
  it('recognises a DASH manifest', () => {
    expect(looksLikeDash(MPD)).toBe(true);
    expect(looksLikeDash('#EXTM3U')).toBe(false);
  });

  it('reads periods, representations and hierarchical BaseURL', () => {
    const manifest = parseDashManifest(MPD, 'https://site.example/stream/manifest.mpd');
    expect(manifest.type).toBe('static');
    expect(manifest.live).toBe(false);
    expect(manifest.duration).toBe(630);
    expect(manifest.periods).toHaveLength(1);

    const period = manifest.periods[0];
    expect(period?.duration).toBe(630);
    expect(period?.representations).toHaveLength(3);

    const video = period?.representations.filter((rep) => rep.contentType === 'video') ?? [];
    expect(video).toHaveLength(2);
    expect(video[0]?.baseUrl).toBe('https://cdn.example/media/');
    expect(video[0]?.height).toBe(1080);
    expect(video[0]?.frameRate).toBeCloseTo(29.97, 2);
    expect(video[0]?.codecs).toEqual(['avc1.640028']);
    // 4.8 Mbit/s for 630s
    expect(video[0]?.sizeBytes).toBe(Math.round((4_800_000 / 8) * 630));

    const audio = period?.representations.find((rep) => rep.contentType === 'audio');
    expect(audio?.language).toBe('en');
    expect(audio?.audioChannels).toBe(2);
  });

  it('detects Widevine ContentProtection', () => {
    const manifest = parseDashManifest(DRM_MPD, 'https://site.example/manifest.mpd');
    expect(manifest.drm).toBe(true);
    expect(manifest.drmSystems).toContain('Widevine');
  });

  it('rejects a document that is not an MPD', () => {
    expect(() => parseDashManifest('<html><body/></html>', 'https://x.example/a')).toThrow(
      /Not an MPD/,
    );
    expect(errorCodeOf(() => parseDashManifest('<html/>', 'https://x.example/a'))).toBe(
      ErrorCode.UNSUPPORTED_MANIFEST,
    );
  });

  it('finds ContentProtection on any level, not only AdaptationSets', () => {
    const repLevel = MPD.replace(
      '<Representation id="a128" bandwidth="128000" codecs="mp4a.40.2">',
      `<Representation id="a128" bandwidth="128000" codecs="mp4a.40.2">
        <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>`,
    );
    const manifest = parseDashManifest(repLevel, 'https://site.example/manifest.mpd');
    expect(manifest.drm).toBe(true);
    expect(manifest.drmSystems).toEqual(['PlayReady']);
  });

  it('starts a Period without @start where the previous one ended (5.3.2.1)', () => {
    const multiPeriod = `<MPD type="static" mediaPresentationDuration="PT90S">
<Period id="ad" duration="PT30S"><AdaptationSet mimeType="video/mp4"><Representation id="a" bandwidth="1"/></AdaptationSet></Period>
<Period id="main"><AdaptationSet mimeType="video/mp4"><Representation id="m" bandwidth="1"/></AdaptationSet></Period></MPD>`;
    const manifest = parseDashManifest(multiPeriod, 'https://x/m.mpd');
    expect(manifest.periods.map(({ id, start, duration }) => ({ id, start, duration }))).toEqual([
      { id: 'ad', start: 0, duration: 30 },
      { id: 'main', start: 30, duration: 60 },
    ]);
  });

  it('inherits a Period-level SegmentTemplate (B14)', () => {
    const periodTemplate = `<MPD type="static" mediaPresentationDuration="PT8S"><Period duration="PT8S">
<SegmentTemplate timescale="1000" duration="4000" media="$RepresentationID$/$Number$.m4s" initialization="$RepresentationID$/init.mp4"/>
<AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000000"/></AdaptationSet></Period></MPD>`;
    const { rep, plan } = firstRepresentation(periodTemplate);
    expect(rep.addressing).toBe('template-duration');
    expect(plan.init?.url).toBe('https://cdn.example/v/v/init.mp4');
    expect(fileNames(plan.segments)).toEqual(['1.m4s', '2.m4s']);
  });

  it('merges SegmentTemplates attribute by attribute, with defaults only after the merge (B13)', () => {
    // The Representation explicitly says timescale="1" startNumber="1": values that equal the
    // defaults must still override the AdaptationSet's 90000 and 0.
    const merge = `<MPD type="static" mediaPresentationDuration="PT8S"><Period duration="PT8S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="90000" startNumber="0" presentationTimeOffset="900000" duration="360000" media="$Number$.m4s"/>
<Representation id="v" bandwidth="1"><SegmentTemplate timescale="1" startNumber="1" duration="4" initialization="init.mp4"/></Representation></AdaptationSet></Period></MPD>`;
    const { rep, plan } = firstRepresentation(merge, 'https://x/m.mpd');
    expect(rep.addressing === 'template-duration' && rep.template).toEqual({
      media: '$Number$.m4s',
      initialization: 'init.mp4',
      timescale: 1,
      startNumber: 1,
      presentationTimeOffset: 900000n,
    });
    expect(plan.init?.url).toBe('https://x/init.mp4');
    expect(plan.segments).toEqual([
      { url: 'https://x/1.m4s', duration: 4 },
      { url: 'https://x/2.m4s', duration: 4 },
    ]);
  });
});

describe('DASH segment plans', () => {
  it('expands $RepresentationID$, zero-padded $Number$ and $Bandwidth$', () => {
    const rep = { id: 'v1080', bandwidth: 4_800_000, baseUrl: 'https://cdn.example/media/' };
    expect(
      expandTemplate('$RepresentationID$/seg-$Number%05d$.m4s', rep, { number: 42, time: 0 }),
    ).toBe('https://cdn.example/media/v1080/seg-00042.m4s');
    expect(expandTemplate('$Bandwidth$/$Number$.m4s', rep, { number: 7, time: 0 })).toBe(
      'https://cdn.example/media/4800000/7.m4s',
    );
    expect(expandTemplate('lit$$eral/$Number$.m4s', rep, { number: 1, time: 0 })).toBe(
      'https://cdn.example/media/lit$eral/1.m4s',
    );
  });

  it('enumerates fixed-duration templates across the period', () => {
    const manifest = parseDashManifest(MPD, 'https://site.example/manifest.mpd');
    const rep = manifest.periods[0]?.representations[0];
    expect(rep?.addressing).toBe('template-duration');

    const plan = buildSegmentPlan(rep as never, { periodDuration: 630 });
    // 630s at 4s per segment
    expect(plan.segments).toHaveLength(158);
    expect(plan.init?.url).toBe('https://cdn.example/media/v1080/init.mp4');
    expect(plan.segments[0]?.url).toBe('https://cdn.example/media/v1080/seg-00001.m4s');
    expect(plan.segments[157]?.url).toBe('https://cdn.example/media/v1080/seg-00158.m4s');
    expect(plan.totalDuration).toBeCloseTo(632, 0);
  });

  it('enumerates a SegmentTimeline including repeats', () => {
    const timelineMpd = `<MPD type="static" mediaPresentationDuration="PT20S">
      <BaseURL>https://cdn.example/</BaseURL>
      <Period id="p" duration="PT20S">
        <AdaptationSet contentType="video" mimeType="video/mp4">
          <SegmentTemplate media="$RepresentationID$/$Time$.m4s" initialization="$RepresentationID$/i.mp4" timescale="1000">
            <SegmentTimeline>
              <S t="0" d="5000" r="2"/>
              <S d="5000"/>
            </SegmentTimeline>
          </SegmentTemplate>
          <Representation id="v" bandwidth="1000000" width="640" height="360"/>
        </AdaptationSet>
      </Period>
    </MPD>`;
    const manifest = parseDashManifest(timelineMpd, 'https://site.example/m.mpd');
    const rep = manifest.periods[0]?.representations[0];
    expect(rep?.addressing).toBe('template-timeline');

    const plan = buildSegmentPlan(rep as never, { periodDuration: 20 });
    expect(plan.segments).toHaveLength(4);
    expect(plan.segments[0]?.url).toBe('https://cdn.example/v/0.m4s');
    expect(plan.segments[1]?.url).toBe('https://cdn.example/v/5000.m4s');
    expect(plan.segments[3]?.url).toBe('https://cdn.example/v/15000.m4s');
    expect(plan.totalDuration).toBeCloseTo(20);
  });

  it('returns an empty plan when there is not enough information, instead of guessing', () => {
    const noDuration = `<MPD type="static">
      <Period id="p">
        <AdaptationSet contentType="video" mimeType="video/mp4">
          <SegmentTemplate media="$Number$.m4s" timescale="1000"/>
          <Representation id="v" bandwidth="1000"/>
        </AdaptationSet>
      </Period>
    </MPD>`;
    const manifest = parseDashManifest(noDuration, 'https://site.example/m.mpd');
    const rep = manifest.periods[0]?.representations[0];
    const plan = buildSegmentPlan(rep as never, {});
    expect(plan.segments).toHaveLength(0);
  });

  it('turns SegmentList entries into ranged segments', () => {
    const listMpd = `<MPD type="static" mediaPresentationDuration="PT8S">
      <BaseURL>https://cdn.example/x/</BaseURL>
      <Period id="p" duration="PT8S">
        <AdaptationSet contentType="video" mimeType="video/mp4">
          <Representation id="v" bandwidth="1000000">
            <SegmentList duration="4000" timescale="1000">
              <Initialization sourceURL="init.mp4"/>
              <SegmentURL media="s1.m4s" mediaRange="0-999"/>
              <SegmentURL media="s2.m4s"/>
            </SegmentList>
          </Representation>
        </AdaptationSet>
      </Period>
    </MPD>`;
    const manifest = parseDashManifest(listMpd, 'https://site.example/m.mpd');
    const rep = manifest.periods[0]?.representations[0];
    expect(rep?.addressing).toBe('list');

    const plan = buildSegmentPlan(rep as never, { periodDuration: 8 });
    expect(plan.init?.url).toBe('https://cdn.example/x/init.mp4');
    expect(plan.segments[0]).toEqual({
      url: 'https://cdn.example/x/s1.m4s',
      range: 'bytes=0-999',
      duration: 4,
    });
    expect(plan.segments[1]?.range).toBeUndefined();
  });

  it('fetches a SegmentBase (on-demand) representation once, whole, with no separate init (B3)', () => {
    const onDemand = `<MPD type="static" mediaPresentationDuration="PT60S"><Period duration="PT60S">
<AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000000" width="1280" height="720">
<BaseURL>video_720.mp4</BaseURL><SegmentBase indexRange="741-1204"><Initialization range="0-740"/></SegmentBase>
</Representation></AdaptationSet></Period></MPD>`;
    const { rep, plan } = firstRepresentation(onDemand);
    expect(rep.addressing).toBe('base');
    expect(rep.baseUrl).toBe('https://cdn.example/v/video_720.mp4');
    expect(plan.init).toBeUndefined();
    expect(plan.segments).toEqual([{ url: 'https://cdn.example/v/video_720.mp4', duration: 60 }]);
  });

  it('treats a bare BaseURL as a single file, but never the MPD itself or a directory (B3)', () => {
    const single = (inside: string) =>
      firstRepresentation(`<MPD type="static" mediaPresentationDuration="PT10S"><Period>
<AdaptationSet mimeType="audio/mp4">${inside}</AdaptationSet></Period></MPD>`).rep;

    const bare = single('<BaseURL>audio/en.m4a</BaseURL><Representation id="a" bandwidth="1"/>');
    expect(bare.addressing).toBe('base');
    expect(bare.baseUrl).toBe('https://cdn.example/v/audio/en.m4a');

    expect(single('<Representation id="a" bandwidth="1"><SegmentBase/></Representation>')).toEqual(
      expect.objectContaining({
        addressing: 'unknown',
        baseUrl: 'https://cdn.example/v/manifest.mpd',
      }),
    );
    expect(single('<BaseURL>audio/</BaseURL><Representation id="a"/>').addressing).toBe('unknown');
  });

  it('keeps a SegmentBase whose init is a separate file as init + whole file', () => {
    const separateInit = `<MPD type="static" mediaPresentationDuration="PT60S"><Period duration="PT60S">
<AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000000">
<BaseURL>media.mp4</BaseURL><SegmentBase><Initialization sourceURL="init.mp4"/></SegmentBase>
</Representation></AdaptationSet></Period></MPD>`;
    const { rep, plan } = firstRepresentation(separateInit);
    expect(rep.addressing).toBe('list');
    expect(plan.init).toEqual({ url: 'https://cdn.example/v/init.mp4' });
    expect(plan.segments).toEqual([{ url: 'https://cdn.example/v/media.mp4' }]);
  });

  it('reads SegmentList byte ranges into the BaseURL when SegmentURL@media is absent (B4)', () => {
    const rangedList = `<MPD type="static" mediaPresentationDuration="PT8S"><Period duration="PT8S">
<AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000000">
<BaseURL>video.mp4</BaseURL>
<SegmentList timescale="1000" duration="4000"><Initialization range="0-862"/>
<SegmentURL mediaRange="863-7005" indexRange="863-906"/><SegmentURL mediaRange="7006-12000"/></SegmentList>
</Representation></AdaptationSet></Period></MPD>`;
    const { rep, plan } = firstRepresentation(rangedList);
    const file = 'https://cdn.example/v/video.mp4';
    expect(rep.addressing).toBe('list');
    expect(plan.init).toEqual({ url: file, range: 'bytes=0-862' });
    expect(plan.segments).toEqual([
      { url: file, range: 'bytes=863-7005', duration: 4 },
      { url: file, range: 'bytes=7006-12000', duration: 4 },
    ]);
    expect(plan.totalDuration).toBe(8);
  });

  it('repeats r="-1" to the Period end measured from presentationTimeOffset (B6)', () => {
    const pto = `<MPD type="static" mediaPresentationDuration="PT60S"><Period duration="PT60S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="90000" presentationTimeOffset="900000" media="$Time$.m4s" initialization="init.mp4">
<SegmentTimeline><S t="900000" d="180000" r="-1"/></SegmentTimeline></SegmentTemplate>
<Representation id="v" bandwidth="1000000"/></AdaptationSet></Period></MPD>`;
    const { plan } = firstRepresentation(pto);
    expect(plan.segments).toHaveLength(30);
    expect(fileNames(plan.segments).at(0)).toBe('900000.m4s');
    expect(fileNames(plan.segments).at(-1)).toBe(`${900_000 + 29 * 180_000}.m4s`);
    expect(plan.totalDuration).toBe(60);

    // Live-to-VOD: t and PTO anchored at the epoch.
    const epoch = firstRepresentation(pto.replace(/900000/g, '153000000000000')).plan;
    expect(epoch.segments).toHaveLength(30);
    expect(fileNames(epoch.segments).at(0)).toBe('153000000000000.m4s');
  });

  it('stops r="-1" at the next S@t instead of running to the Period end (B6)', () => {
    const midRepeat = `<MPD type="static" mediaPresentationDuration="PT20S"><Period duration="PT20S">
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" media="$Time$.m4s">
<SegmentTimeline><S t="0" d="2" r="-1"/><S t="10" d="5" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="v" bandwidth="1000000"/></AdaptationSet></Period></MPD>`;
    const { plan } = firstRepresentation(midRepeat);
    expect(fileNames(plan.segments)).toEqual([
      '0.m4s',
      '2.m4s',
      '4.m4s',
      '6.m4s',
      '8.m4s',
      '10.m4s',
      '15.m4s',
    ]);
    expect(plan.totalDuration).toBe(20);
  });

  it('keeps $Time$ exact above 2^53 (B15)', () => {
    const bigTime = `<MPD type="static" mediaPresentationDuration="PT4S"><Period duration="PT4S"><AdaptationSet mimeType="video/mp4">
<SegmentTemplate timescale="10000000" media="t$Time$.m4s"><SegmentTimeline><S t="17000000000000001" d="20000000" r="1"/></SegmentTimeline></SegmentTemplate>
<Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`;
    const { plan } = firstRepresentation(bigTime, 'https://x/m.mpd');
    expect(fileNames(plan.segments)).toEqual(['t17000000000000001.m4s', 't17000000020000001.m4s']);
    expect(plan.segments.map((segment) => segment.duration)).toEqual([2, 2]);
  });

  it('counts @duration segments in whole ticks, so float error adds no phantom segment', () => {
    const ntsc = `<MPD type="static" mediaPresentationDuration="PT6.006S"><Period>
<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1000" duration="2002" media="$Number$.m4s"/>
<Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`;
    expect(firstRepresentation(ntsc).plan.segments).toHaveLength(3);
  });

  it('never lets a zero, negative or NaN duration into a plan', () => {
    const withTemplate = (template: string, presentation = 'PT8S') =>
      firstRepresentation(`<MPD type="static" mediaPresentationDuration="${presentation}"><Period>
<AdaptationSet mimeType="video/mp4">${template}<Representation id="v" bandwidth="1000"/></AdaptationSet></Period></MPD>`);

    // S@d="0" with r="-1" would repeat forever; it is dropped, the valid S survives.
    const zeroS = withTemplate(
      '<SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S t="0" d="0" r="-1"/><S t="0" d="4" r="1"/></SegmentTimeline></SegmentTemplate>',
    );
    expect(fileNames(zeroS.plan.segments)).toEqual(['0.m4s', '4.m4s']);

    for (const bad of [
      '<SegmentTemplate media="$Number$.m4s" duration="0"/>',
      '<SegmentTemplate media="$Number$.m4s" duration="-4"/>',
      '<SegmentTemplate media="$Number$.m4s" duration="4" timescale="0"/>',
      '<SegmentTemplate media="$Number$.m4s" duration="4" timescale="-1"/>',
      '<SegmentTemplate media="$Time$.m4s" timescale="0"><SegmentTimeline><S t="0" d="4"/></SegmentTimeline></SegmentTemplate>',
    ]) {
      const { rep, plan } = withTemplate(bad);
      expect(rep.addressing, bad).toBe('unknown');
      expect(plan.segments, bad).toHaveLength(0);
    }

    // A SegmentList with timescale="0" keeps its segments but loses their (meaningless) lengths.
    const list = withTemplate(
      '<BaseURL>v.mp4</BaseURL><SegmentList timescale="0" duration="4"><SegmentURL mediaRange="0-9"/></SegmentList>',
    );
    expect(list.plan.segments).toEqual([
      { url: 'https://cdn.example/v/v.mp4', range: 'bytes=0-9' },
    ]);

    // A negative duration, on the MPD or on the Period, is unknown - not a negative Period.
    const negativeMpd = withTemplate(
      '<SegmentTemplate media="$Number$.m4s" duration="4"/>',
      '-PT8S',
    );
    expect(negativeMpd.period.duration).toBeUndefined();
    expect(negativeMpd.plan.segments).toHaveLength(0);
    const negativePeriod = firstRepresentation(`<MPD type="static"><Period duration="-PT8S">
<AdaptationSet mimeType="video/mp4"><BaseURL>v.mp4</BaseURL><Representation id="v" bandwidth="1000"/></AdaptationSet></Period></MPD>`);
    expect(negativePeriod.period.duration).toBeUndefined();
    expect(negativePeriod.rep.sizeBytes).toBeUndefined();
    expect(negativePeriod.plan.segments).toEqual([{ url: 'https://cdn.example/v/v.mp4' }]);

    const nanPeriod = buildSegmentPlan(list.rep, { periodDuration: Number.NaN });
    expect(nanPeriod.totalDuration).toBe(0);
    expect(nanPeriod.segments.every((segment) => segment.duration === undefined)).toBe(true);
  });
});
