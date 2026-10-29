import { describe, expect, it } from 'vitest';
import { parseMessage } from '../../src/core/messages.ts';
import { domainOf, redactDeep, redactUrl } from '../../src/core/redact.ts';
import type { PageSignals, ScanStats } from '../../src/core/types.ts';
import { diagnose } from '../../src/detection/diagnose.ts';
import { classifyMediaUrl } from '../../src/media/format.ts';
import { scriptMatchesFor } from '../../src/permissions/content-scripts.ts';
import { originPatternFor } from '../../src/permissions/site-access.ts';
import { groupByDay, type HistoryEntry } from '../../src/storage/history.ts';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/storage/settings.ts';
import { summarizeUserAgent } from '../../src/ui/lib/diagnostics.ts';

const isSegment = (url: string) => classifyMediaUrl(url)?.isSegment === true;

const noSignals: PageSignals = {
  hasMediaSource: false,
  hasMediaKeys: false,
  mediaElements: 0,
  playerFrames: 0,
};

const emptyStats: ScanStats = {
  networkRequestsObserved: 0,
  mediaElements: 0,
  candidatesRaw: 0,
  candidatesAfterDedupe: 0,
  manifestsParsed: 0,
  byProtocol: { progressive: 0, hls: 0, dash: 0, blob: 0, data: 0, unknown: 0 },
  parseErrors: 0,
};

describe('message validation', () => {
  it('rejects anything that is not a known message', () => {
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage('hello')).toBeNull();
    expect(parseMessage({ type: 'EVAL_THIS' })).toBeNull();
  });

  it('drops malformed candidates and caps the batch', () => {
    const message = parseMessage({
      type: 'PAGE_REPORT',
      pageUrl: 'https://site.example/',
      pageTitle: 'Page',
      candidates: [
        { url: 'https://cdn.example/a.mp4', kind: 'video', source: 'dom-element' },
        { url: '', kind: 'video', source: 'dom-element' },
        { kind: 'video', source: 'dom-element' },
        ...Array.from({ length: 600 }, () => ({
          url: 'https://cdn.example/x.mp4',
          kind: 'video',
          source: 'dom-element',
        })),
      ],
    });
    expect(message?.type).toBe('PAGE_REPORT');
    if (message?.type !== 'PAGE_REPORT') throw new Error('wrong type');
    expect(message.candidates.length).toBe(198); // 200 read, 2 malformed dropped
  });

  it('pass 2 regression: keeps only what a page can honestly claim about a URL', () => {
    const message = parseMessage({
      type: 'PAGE_REPORT',
      pageUrl: 'https://site.example/',
      pageTitle: 'Page',
      routeStartedAt: 1,
      candidates: [
        {
          url: 'https://cdn.example/a.m3u8',
          kind: 'video',
          source: 'dom-element',
          title: '  Trailer  ',
          resolution: { width: 1920, height: 1080 },
          variants: [{ url: 'https://evil.example/' }],
          drm: false,
          score: 99,
        },
        { url: 'javascript:alert(1)//.mp4', kind: 'video', source: 'dom-attribute' },
        { url: 'data:video/mp4;base64,AAAA', kind: 'video', source: 'dom-element' },
        { url: 'https://cdn.example/b.mp4', kind: 'video', source: 'network' },
        { url: 'https://cdn.example/c.mp4', kind: 'executable', source: 'dom-element' },
        {
          url: 'https://cdn.example/d.mp4',
          kind: 'video',
          source: 'dom-element',
          resolution: { width: 1e9, height: 1080 },
        },
      ],
    });
    if (message?.type !== 'PAGE_REPORT') throw new Error('wrong type');
    expect(message.candidates).toEqual([
      {
        url: 'https://cdn.example/a.m3u8',
        kind: 'video',
        source: 'dom-element',
        title: 'Trailer',
        resolution: { width: 1920, height: 1080 },
      },
      { url: 'https://cdn.example/d.mp4', kind: 'video', source: 'dom-element' },
    ]);
  });

  it('refuses a page report without a page or a candidate list', () => {
    expect(parseMessage({ type: 'PAGE_REPORT', pageTitle: 'x', candidates: [] })).toBeNull();
    expect(parseMessage({ type: 'PAGE_REPORT', pageUrl: 'https://a/', pageTitle: 'x' })).toBeNull();
  });

  it('turns hostile counts into small whole numbers', () => {
    const message = parseMessage({
      type: 'PAGE_REPORT',
      pageUrl: 'https://site.example/',
      pageTitle: 'Page',
      signals: { mediaElements: -4, playerFrames: 1e9 },
      candidates: [],
    });
    if (message?.type !== 'PAGE_REPORT') throw new Error('wrong type');
    expect(message.signals.mediaElements).toBe(0);
    expect(message.signals.playerFrames).toBe(1000);
  });

  it('does not pass unknown or worker-only shapes through as anything else', () => {
    expect(parseMessage({ type: 'CANDIDATES_FOUND', candidates: [] })).toBeNull();
    expect(parseMessage({ type: 'GET_DOWNLOADS', extra: 'ignored' })).toEqual({
      type: 'GET_DOWNLOADS',
    });
  });

  it('validates download commands', () => {
    expect(parseMessage({ type: 'DOWNLOAD_COMMAND', taskId: 't1', command: 'pause' })).toEqual({
      type: 'DOWNLOAD_COMMAND',
      taskId: 't1',
      command: 'pause',
    });
    expect(parseMessage({ type: 'DOWNLOAD_COMMAND', taskId: 't1', command: 'rm -rf' })).toBeNull();
    expect(parseMessage({ type: 'DOWNLOAD_COMMAND', command: 'pause' })).toBeNull();
  });

  it('truncates a hostile page title', () => {
    const message = parseMessage({
      type: 'PAGE_REPORT',
      pageUrl: 'https://site.example/',
      pageTitle: 'x'.repeat(5000),
      signals: { hasMediaSource: true, hasMediaKeys: 'yes' },
      candidates: [],
    });
    if (message?.type !== 'PAGE_REPORT') throw new Error('wrong type');
    expect(message.pageTitle.length).toBe(300);
    expect(message.signals.hasMediaSource).toBe(true);
    expect(message.signals.hasMediaKeys).toBe(false);
  });

  it('requires a numeric tabId for START_DOWNLOAD', () => {
    expect(parseMessage({ type: 'START_DOWNLOAD', candidateId: 'c', tabId: '3' })).toBeNull();
    expect(parseMessage({ type: 'START_DOWNLOAD', candidateId: 'c', tabId: 3 })).toEqual({
      type: 'START_DOWNLOAD',
      candidateId: 'c',
      tabId: 3,
    });
  });
});

describe('redaction', () => {
  it('replaces token-like query parameters', () => {
    const redacted = redactUrl('https://cdn.example/v.mp4?token=secret&Expires=123&quality=hd');
    expect(redacted).toContain('quality=hd');
    expect(redacted).not.toContain('secret');
    expect(redacted).toContain('REDACTED');
  });

  it('replaces signature-shaped path segments', () => {
    const redacted = redactUrl(`https://cdn.example/${'a1b2c3d4'.repeat(6)}/v.mp4`);
    expect(redacted).toContain('/REDACTED/v.mp4');
  });

  it('never leaks blob or data URLs', () => {
    expect(redactUrl('blob:https://site.example/abc')).toBe('blob:[redacted]');
    expect(redactUrl('data:video/mp4;base64,AAAA')).toBe('data:[redacted]');
  });

  it('strips credentials and fragments', () => {
    expect(redactUrl('https://u:p@cdn.example/v.mp4#t=1')).toBe('https://cdn.example/v.mp4');
  });

  it('redacts header-shaped keys anywhere in an object graph', () => {
    const redacted = redactDeep({
      nested: {
        cookie: 'session=abc',
        referer: 'https://site.example/',
        url: 'https://cdn.example/v.mp4?token=x',
      },
    }) as { nested: Record<string, string> };
    expect(redacted.nested.cookie).toBe('REDACTED');
    expect(redacted.nested.referer).toBe('REDACTED');
    expect(redacted.nested.url).not.toContain('token=x');
  });

  it('extracts a domain safely', () => {
    expect(domainOf('https://www.example.com/x')).toBe('www.example.com');
    expect(domainOf('nonsense')).toBe('unknown');
  });

  it('reduces a user agent to family and major version', () => {
    expect(
      summarizeUserAgent('Mozilla/5.0 (X11) AppleWebKit/537 Chrome/130.0.0.0 Safari/537'),
    ).toBe('Chrome 130');
    expect(summarizeUserAgent('Mozilla/5.0 Firefox/131.0')).toBe('Firefox 131');
    expect(summarizeUserAgent('curl/8')).toBe('Unknown browser');
  });
});

describe('settings', () => {
  it('fills in every field a stored object is missing', () => {
    const merged = mergeSettings({ downloads: { concurrentDownloads: 6 } });
    expect(merged.downloads.concurrentDownloads).toBe(6);
    expect(merged.downloads.retryCount).toBe(DEFAULT_SETTINGS.downloads.retryCount);
    expect(merged.privacy.keepHistory).toBe(true);
  });

  it('ignores unknown keys and wrong types from storage', () => {
    const merged = mergeSettings({
      downloads: { concurrentDownloads: 'lots', evil: true },
      nonsense: 1,
    });
    expect(merged.downloads.concurrentDownloads).toBe(
      DEFAULT_SETTINGS.downloads.concurrentDownloads,
    );
    expect((merged.downloads as Record<string, unknown>).evil).toBeUndefined();
  });

  it('clamps values that would break the download engine', () => {
    const merged = mergeSettings({
      downloads: { concurrentDownloads: 500, segmentConcurrency: -3, retryCount: 99 },
    });
    expect(merged.downloads.concurrentDownloads).toBe(8);
    expect(merged.downloads.segmentConcurrency).toBe(0);
    expect(merged.downloads.retryCount).toBe(10);
  });

  it('never accepts an empty naming template', () => {
    expect(mergeSettings({ downloads: { namingTemplate: '   ' } }).downloads.namingTemplate).toBe(
      DEFAULT_SETTINGS.downloads.namingTemplate,
    );
  });

  it('drops settings written by an older version that no longer exist', () => {
    const merged = mergeSettings({ privacy: { telemetry: true, keepHistory: false } });
    expect(merged.privacy.keepHistory).toBe(false);
    expect((merged.privacy as Record<string, unknown>).telemetry).toBeUndefined();
  });
});

describe('history grouping', () => {
  it('labels today, yesterday and older days', () => {
    const now = new Date('2026-09-07T12:00:00');
    const entry = (completedAt: number, id: string): HistoryEntry => ({
      id,
      filename: `${id}.mp4`,
      domain: 'site.example',
      completedAt,
    });

    const groups = groupByDay(
      [
        entry(new Date('2026-09-07T09:00:00').getTime(), 'a'),
        entry(new Date('2026-09-06T09:00:00').getTime(), 'b'),
        entry(new Date('2026-09-01T09:00:00').getTime(), 'c'),
      ],
      now,
    );

    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday', '2026-09-01']);
  });
});

describe('diagnosis', () => {
  const stats = (requests: number): ScanStats => ({
    ...emptyStats,
    networkRequestsObserved: requests,
  });

  it('says nothing when there is usable media', () => {
    expect(diagnose([{ drm: false } as never], stats(10), noSignals)).toBeUndefined();
  });

  it('reports DRM above everything else', () => {
    const signals = { ...noSignals, hasMediaSource: true, hasMediaKeys: true, mediaElements: 1 };
    expect(diagnose([], stats(50), signals)?.code).toBe('DRM_PROTECTED');
  });

  it('explains MediaSource playback', () => {
    const result = diagnose([], stats(50), {
      ...noSignals,
      hasMediaSource: true,
      mediaElements: 1,
    });
    expect(result?.code).toBe('MSE_ONLY');
    expect(result?.reasons.join(' ')).toMatch(/press play|playback starts/i);
  });

  it('tells the user to press play when the player has not requested anything', () => {
    expect(diagnose([], stats(1), { ...noSignals, mediaElements: 2 })?.code).toBe('NOT_STARTED');
  });

  it('points at an embedded player from another site when there is no player of our own', () => {
    const result = diagnose([], stats(40), { ...noSignals, playerFrames: 2 });
    expect(result?.code).toBe('CROSS_ORIGIN_FRAME');
  });

  it('pass 2 regression: ad and widget frames are not embedded players', () => {
    expect(diagnose([], stats(40), noSignals)?.code).toBe('NO_MEDIA_YET');
  });
});

describe('segment URL recognition', () => {
  it('treats numbered chunk URLs as segments, not downloads', () => {
    expect(isSegment('https://cdn.example/v/seg-00042.m4s')).toBe(true);
    expect(isSegment('https://cdn.example/v/chunk_1.ts')).toBe(true);
    expect(isSegment('https://cdn.example/v/000123.m4s')).toBe(true);
    expect(isSegment('https://cdn.example/v/init.mp4')).toBe(true);
  });

  it('never treats a manifest as a segment', () => {
    expect(isSegment('https://cdn.example/v/master.m3u8')).toBe(false);
    expect(isSegment('https://cdn.example/v/manifest.mpd')).toBe(false);
  });

  it('leaves whole files alone', () => {
    expect(isSegment('https://cdn.example/videos/lecture.mp4')).toBe(false);
  });
});

describe('site access', () => {
  it('builds an origin pattern only for pages we can operate on', () => {
    expect(originPatternFor('https://example.com/watch?v=1')).toBe('https://example.com/*');
    expect(originPatternFor('http://localhost:3000/a')).toBe('http://localhost/*');
    expect(originPatternFor('chrome://extensions')).toBeNull();
    expect(originPatternFor('file:///Users/x/video.mp4')).toBeNull();
    expect(originPatternFor('about:blank')).toBeNull();
    expect(originPatternFor('not a url')).toBeNull();
  });

  it('expands an all-sites grant into the two schemes a content script can use', () => {
    expect(scriptMatchesFor(['*://*/*']).sort()).toEqual(['http://*/*', 'https://*/*']);
  });

  it('passes granted http(s) origins through and drops everything else', () => {
    expect(scriptMatchesFor(['https://a.test/*', 'ftp://b.test/*', 'https://a.test/*'])).toEqual([
      'https://a.test/*',
    ]);
    expect(scriptMatchesFor([])).toEqual([]);
  });
});
