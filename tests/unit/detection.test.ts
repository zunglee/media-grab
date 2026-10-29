/**
 * The detection pipeline's pure parts, driven with fakes: the page hook's
 * message gate, the manifest cache, and how the engine folds playlists a
 * master already lists. Browser-only behaviour (the hook itself, Resource
 * Timing) is covered by tests/extension.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __setBrowserApi } from '../../src/browser/index.ts';
import { HOOK_CHANNEL, parseHookMessage } from '../../src/core/hook-protocol.ts';
import { MAX_URL_LENGTH } from '../../src/core/limits.ts';
import type { MediaCandidate, MediaVariant } from '../../src/core/types.ts';
import { makeCandidate } from '../../src/detection/candidate.ts';
import { runScan } from '../../src/detection/engine.ts';
import { ManifestCache } from '../../src/detection/manifest-cache.ts';
import type { ManifestDetails } from '../../src/detection/manifest-loader.ts';
import { syncContentScriptRegistration } from '../../src/permissions/content-scripts.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';

const PAGE = 'https://site.example/watch/1';

afterEach(() => __setBrowserApi(null));

describe('the page hook message gate', () => {
  const on = (message: Record<string, unknown>) => ({ channel: HOOK_CHANNEL, ...message });

  it('accepts exactly our shapes', () => {
    expect(parseHookMessage(on({ kind: 'url', url: 'https://cdn.example/a.m3u8' }))).toEqual({
      kind: 'url',
      url: 'https://cdn.example/a.m3u8',
    });
    expect(parseHookMessage(on({ kind: 'navigate', extra: 'ignored' }))).toEqual({
      kind: 'navigate',
    });
  });

  it('drops another channel, an unknown kind, and an oversized URL', () => {
    expect(parseHookMessage({ channel: 'someone-else', kind: 'mse' })).toBeNull();
    expect(parseHookMessage(on({ kind: 'eval' }))).toBeNull();
    expect(parseHookMessage(on({ kind: 'url', url: 'x'.repeat(MAX_URL_LENGTH + 1) }))).toBeNull();
    expect(parseHookMessage(on({ kind: 'url', url: 42 }))).toBeNull();
    expect(parseHookMessage('mediagrab:page-hook')).toBeNull();
  });
});

describe('the manifest cache', () => {
  const master = (url: string) =>
    makeCandidate({ url, pageUrl: PAGE, kind: 'video', source: 'network' });
  const details: ManifestDetails = { protocol: 'hls', variants: [] };

  it('fetches a manifest once while it is fresh, whatever its signature', async () => {
    const load = vi.fn(async () => details);
    let now = 0;
    const cache = new ManifestCache(load, () => now);
    await cache.details(master('https://cdn.example/a.m3u8?token=1'));
    await cache.details(master('https://cdn.example/a.m3u8?token=2'));
    expect(load).toHaveBeenCalledTimes(1);
    now = 31_000;
    await cache.details(master('https://cdn.example/a.m3u8?token=3'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not remember a failure', async () => {
    const load = vi
      .fn<() => Promise<ManifestDetails>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(details);
    const cache = new ManifestCache(load);
    await expect(cache.details(master('https://cdn.example/a.m3u8'))).rejects.toThrow();
    await expect(cache.details(master('https://cdn.example/a.m3u8'))).resolves.toBe(details);
  });

  it('forgets the oldest manifest when full', async () => {
    const load = vi.fn(async () => details);
    const cache = new ManifestCache(load);
    for (let i = 0; i <= 32; i += 1) await cache.details(master(`https://cdn.example/${i}.m3u8`));
    await cache.details(master('https://cdn.example/0.m3u8'));
    expect(load).toHaveBeenCalledTimes(34);
  });
});

describe('playlists a master already lists', () => {
  function playlist(path: string): MediaCandidate {
    return makeCandidate({
      url: `https://cdn.example/${path}`,
      pageUrl: PAGE,
      kind: 'video',
      source: 'network',
    });
  }
  const rendition = (path: string, audio: boolean): MediaVariant => ({
    id: path,
    url: `https://cdn.example/${path}`,
    kind: audio ? 'audio' : 'video',
    protocol: 'hls',
    format: 'ts',
    tracks: { video: !audio, audio },
    ...(audio
      ? { label: 'English', language: 'en' }
      : { resolution: { width: 1280, height: 720 } }),
  });

  it('re-audit regression: keeps an audio playlist as an audio row, folds renditions and subtitles', async () => {
    const found = ['master.m3u8', '720.m3u8', 'audio/en.m3u8', 'subs/en.m3u8'].map(playlist);
    const scan = await runScan({
      tabId: 1,
      pageUrl: PAGE,
      pageTitle: 'Watch',
      pageCandidates: [],
      networkCandidates: found,
      signals: { hasMediaSource: false, hasMediaKeys: false, mediaElements: 1, playerFrames: 0 },
      requestsObserved: 20,
      manifests: {
        details: async (candidate) =>
          candidate.url.endsWith('master.m3u8')
            ? {
                protocol: 'hls',
                kind: 'video',
                variants: [rendition('720.m3u8', false)],
                audioTracks: [rendition('audio/en.m3u8', true)],
                subtitles: [
                  {
                    id: 's',
                    url: 'https://cdn.example/subs/en.m3u8',
                    format: 'vtt',
                    label: 'English',
                  },
                ],
              }
            : { protocol: 'hls', variants: [] },
      },
    });
    const rows = scan.candidates.map((c) => [c.url.replace('https://cdn.example/', ''), c.kind]);
    expect(rows).toContainEqual(['master.m3u8', 'video']);
    expect(rows).toContainEqual(['audio/en.m3u8', 'audio']);
    expect(rows.map(([url]) => url)).not.toContain('720.m3u8');
    expect(rows.map(([url]) => url)).not.toContain('subs/en.m3u8');
  });
});

describe('content-script registration', () => {
  it('re-audit regression: a worker restart leaves an unchanged registration alone', async () => {
    const api = createFakeBrowserApi();
    const matches = ['https://example.test/*'];
    api.scripting.registeredContentScripts = async () => [
      { id: 'mediagrab-page-hook', matches },
      { id: 'mediagrab-content', matches },
    ];
    const unregister = vi.fn(async () => undefined);
    const register = vi.fn(async () => undefined);
    api.scripting.unregisterContentScript = unregister;
    api.scripting.registerContentScript = register;
    __setBrowserApi(api);

    await syncContentScriptRegistration();
    expect(unregister).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();

    api.permissions.getOrigins = async () => ['https://example.test/*', 'https://other.test/*'];
    await syncContentScriptRegistration();
    expect(register).toHaveBeenCalledTimes(2);
  });
});
