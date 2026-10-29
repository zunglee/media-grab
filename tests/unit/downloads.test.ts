import { describe, expect, it, vi } from 'vitest';
import { DownloadState } from '../../src/core/download-types.ts';
import {
  codeForHttpStatus,
  ErrorCode,
  isRetryable,
  isTerminal,
  toMediaGrabError,
} from '../../src/core/errors.ts';
import {
  formatEta,
  formatSpeed,
  fractionComplete,
  ProgressTracker,
} from '../../src/downloads/progress.ts';
import { fetchSegments, parseRetryAfter } from '../../src/downloads/segment-fetcher.ts';
import {
  canTransition,
  commandTarget,
  isActive,
  transition,
} from '../../src/downloads/state-machine.ts';
import type { SegmentPlan } from '../../src/manifests/segment-plan.ts';

describe('state machine', () => {
  it('allows the normal path', () => {
    expect(canTransition(DownloadState.QUEUED, DownloadState.DOWNLOADING)).toBe(true);
    expect(canTransition(DownloadState.DOWNLOADING, DownloadState.VERIFYING)).toBe(true);
    expect(canTransition(DownloadState.VERIFYING, DownloadState.COMPLETED)).toBe(true);
  });

  it('refuses to leave a terminal state', () => {
    expect(transition(DownloadState.COMPLETED, DownloadState.QUEUED).ok).toBe(false);
    expect(transition(DownloadState.CANCELLED, DownloadState.DOWNLOADING).ok).toBe(false);
  });

  it('refuses to skip states', () => {
    expect(transition(DownloadState.PAUSED, DownloadState.DOWNLOADING).ok).toBe(false);
    expect(transition(DownloadState.PAUSED, DownloadState.RESUMING).ok).toBe(true);
  });

  it('reports a reason for every refusal', () => {
    const result = transition(DownloadState.COMPLETED, DownloadState.QUEUED);
    expect(result.reason).toContain('terminal');
  });

  it('maps user commands to legal targets only', () => {
    expect(commandTarget(DownloadState.DOWNLOADING, 'pause')).toBe(DownloadState.PAUSED);
    expect(commandTarget(DownloadState.PAUSED, 'pause')).toBeNull();
    expect(commandTarget(DownloadState.FAILED, 'retry')).toBe(DownloadState.QUEUED);
    expect(commandTarget(DownloadState.COMPLETED, 'cancel')).toBeNull();
  });

  it('knows which states are in flight', () => {
    expect(isActive(DownloadState.DOWNLOADING)).toBe(true);
    expect(isActive(DownloadState.QUEUED)).toBe(false);
  });
});

describe('error classification', () => {
  it('maps HTTP statuses to codes', () => {
    expect(codeForHttpStatus(401)).toBe(ErrorCode.AUTH_REQUIRED);
    expect(codeForHttpStatus(403)).toBe(ErrorCode.STREAM_EXPIRED);
    expect(codeForHttpStatus(404)).toBe(ErrorCode.MEDIA_NOT_FOUND);
    expect(codeForHttpStatus(429)).toBe(ErrorCode.SERVER_REJECTED);
    expect(codeForHttpStatus(503)).toBe(ErrorCode.SERVER_REJECTED);
  });

  it('separates retryable from terminal failures', () => {
    expect(isRetryable(ErrorCode.NETWORK_ERROR)).toBe(true);
    expect(isRetryable(ErrorCode.DRM_PROTECTED)).toBe(false);
    expect(isTerminal(ErrorCode.DRM_PROTECTED)).toBe(true);
    expect(isTerminal(ErrorCode.NETWORK_ERROR)).toBe(false);
  });

  it('treats an aborted fetch as a cancellation, not a failure', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(toMediaGrabError(abort).code).toBe(ErrorCode.CANCELLED);
  });
});

describe('progress', () => {
  it('smooths the speed instead of reporting instantaneous bursts', () => {
    const tracker = new ProgressTracker(10_000, 0);
    tracker.update(1_000, 1_000);
    const first = tracker.snapshot().speedBps;
    tracker.update(1_000, 2_000); // a stalled second
    const second = tracker.snapshot().speedBps;
    expect(first).toBeGreaterThan(0);
    expect(second).toBeLessThan(first);
    expect(second).toBeGreaterThan(0);
  });

  it('ignores samples that are too short to measure', () => {
    const tracker = new ProgressTracker(10_000, 0);
    tracker.update(500, 50);
    expect(tracker.snapshot().speedBps).toBe(0);
  });

  it('computes an ETA only when the total is known', () => {
    const tracker = new ProgressTracker(undefined, 0);
    tracker.update(1_000, 1_000);
    expect(tracker.snapshot().etaSeconds).toBeUndefined();

    const sized = new ProgressTracker(10_000, 0);
    sized.update(1_000, 1_000);
    expect(sized.snapshot().etaSeconds).toBeGreaterThan(0);
  });

  it('falls back to segment counts when byte totals are unknown', () => {
    expect(
      fractionComplete({ receivedBytes: 0, speedBps: 0, segmentsDone: 5, segmentsTotal: 10 }),
    ).toBe(0.5);
    expect(fractionComplete({ receivedBytes: 50, totalBytes: 200, speedBps: 0 })).toBe(0.25);
    expect(fractionComplete({ receivedBytes: 50, speedBps: 0 })).toBe(0);
  });

  it('formats speed and ETA', () => {
    expect(formatSpeed(8_800_000)).toBe('8.4 MB/s');
    expect(formatSpeed(51_200)).toBe('50 KB/s');
    expect(formatEta(31)).toBe('31 sec');
    expect(formatEta(undefined)).toBe('--');
  });
});

describe('segment fetching', () => {
  const plan = (count: number): SegmentPlan => ({
    init: { url: 'https://cdn.example/init.mp4' },
    segments: Array.from({ length: count }, (_unused, i) => ({
      url: `https://cdn.example/seg-${i}.m4s`,
      duration: 4,
    })),
    totalDuration: count * 4,
    live: false,
  });

  function fakeFetch(behaviour: (url: string, attempt: number) => Response): typeof fetch {
    const attempts = new Map<string, number>();
    return (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      return behaviour(url, attempt);
    }) as typeof fetch;
  }

  function ok(body: string): Response {
    return new Response(new TextEncoder().encode(body), { status: 200 });
  }

  it('returns segments in playlist order regardless of completion order', async () => {
    const fetchImpl = fakeFetch((url) => ok(url.slice(-8)));
    const result = await fetchSegments({
      plan: plan(6),
      signal: new AbortController().signal,
      fetchImpl,
      retries: 0,
    });

    expect(result.failed).toHaveLength(0);
    expect(result.parts).toHaveLength(7); // init + 6
    const text = await new Blob(result.parts).text();
    expect(text.indexOf('seg-0')).toBeLessThan(text.indexOf('seg-1'));
    expect(text.indexOf('seg-4')).toBeLessThan(text.indexOf('seg-5'));
  });

  it('retries a failing segment and succeeds', async () => {
    const fetchImpl = fakeFetch((url, attempt) => {
      if (url.includes('seg-2') && attempt < 3) return new Response(null, { status: 500 });
      return ok(url);
    });
    const result = await fetchSegments({
      plan: plan(4),
      signal: new AbortController().signal,
      fetchImpl,
      retries: 3,
    });
    expect(result.failed).toHaveLength(0);
  });

  it('reports the segments that failed every retry', async () => {
    const fetchImpl = fakeFetch((url) =>
      url.includes('seg-1') ? new Response(null, { status: 404 }) : ok(url),
    );
    const result = await fetchSegments({
      plan: plan(3),
      signal: new AbortController().signal,
      fetchImpl,
      retries: 1,
    });
    expect(result.failed).toHaveLength(1);
  });

  it('sends the Range header for byte-range segments', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return ok('x');
    }) as typeof fetch;

    await fetchSegments({
      plan: {
        segments: [{ url: 'https://cdn.example/all.ts', range: 'bytes=0-999' }],
        totalDuration: 4,
        live: false,
      },
      signal: new AbortController().signal,
      fetchImpl,
      retries: 0,
    });
    expect(seen[0]?.Range).toBe('bytes=0-999');
  });

  it('never sends credentials', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return ok('x');
    }) as typeof fetch;

    await fetchSegments({
      plan: plan(1),
      signal: new AbortController().signal,
      fetchImpl,
      retries: 0,
    });
    expect(seen.every((init) => init.credentials === 'omit')).toBe(true);
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = fakeFetch((url) => {
      controller.abort();
      return ok(url);
    });

    await expect(
      fetchSegments({ plan: plan(20), signal: controller.signal, fetchImpl, retries: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.CANCELLED });
  });

  it('refuses a plan with no segments', async () => {
    await expect(
      fetchSegments({
        plan: { segments: [], totalDuration: 0, live: false },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_MANIFEST });
  });

  it('honours Retry-After in both formats', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(null)).toBeUndefined();
    const soon = new Date(Date.now() + 3000).toUTCString();
    const parsed = parseRetryAfter(soon);
    expect(parsed).toBeGreaterThan(0);
  });
});

describe('assembler', () => {
  it('refuses to write a file with holes in it', async () => {
    vi.resetModules();
    const { assembleToObjectUrl } = await import('../../src/downloads/assembler.ts');
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('seg-1')) return new Response(null, { status: 500 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;

    await expect(
      assembleToObjectUrl({
        plan: {
          segments: [
            { url: 'https://cdn.example/seg-0.m4s' },
            { url: 'https://cdn.example/seg-1.m4s' },
          ],
          totalDuration: 8,
          live: false,
        },
        mimeType: 'video/mp4',
        retries: 0,
        signal: new AbortController().signal,
        fetchImpl,
      }),
      // The failure keeps the classification of the underlying HTTP status and
      // says why, rather than collapsing to a generic "segments failed".
    ).rejects.toMatchObject({
      code: ErrorCode.SERVER_REJECTED,
      message: expect.stringContaining('HTTP 500'),
      detail: expect.stringContaining('seg-1'),
    });
  });
});

describe('fetch binding', () => {
  it('calls the global fetch with its receiver, not detached', async () => {
    // Regression test for "Failed to execute 'fetch' on 'Window': Illegal
    // invocation". A detached `fetch` works in a service worker and throws in
    // the offscreen document, which broke every HLS/DASH download on Chrome.
    const original = globalThis.fetch;
    const receivers: unknown[] = [];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: function patched(this: unknown) {
        receivers.push(this);
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
      },
    });

    try {
      const { fetchSegments } = await import('../../src/downloads/segment-fetcher.ts');
      await fetchSegments({
        plan: {
          segments: [{ url: 'https://cdn.example/seg-0.m4s' }],
          totalDuration: 4,
          live: false,
        },
        signal: new AbortController().signal,
        retries: 0,
      });
      expect(receivers).toHaveLength(1);
      expect(receivers[0], 'fetch was called detached from globalThis').toBe(globalThis);
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});

describe('re-audit: retrying what can pass, refusing what would be cut short', () => {
  it('regression: retries a playlist fetch that failed with a 503, but not a 404', async () => {
    const { retrying } = await import('../../src/downloads/retry.ts');
    const { MediaGrabError: Err } = await import('../../src/core/errors.ts');
    vi.useFakeTimers();
    try {
      let calls = 0;
      const flaky = retrying(
        async () => {
          calls += 1;
          if (calls === 1) throw new Err(ErrorCode.SERVER_REJECTED, 'HTTP 503');
          return 'playlist';
        },
        { retries: 3, signal: new AbortController().signal },
      );
      await vi.runAllTimersAsync();
      await expect(flaky).resolves.toBe('playlist');
      expect(calls).toBe(2);

      let missing = 0;
      const gone = retrying(
        async () => {
          missing += 1;
          throw new Err(ErrorCode.MEDIA_NOT_FOUND, 'HTTP 404');
        },
        { retries: 3, signal: new AbortController().signal },
      );
      await expect(gone).rejects.toMatchObject({ code: ErrorCode.MEDIA_NOT_FOUND });
      expect(missing).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('regression: refuses a multi-period DASH stream instead of saving only its first part', async () => {
    const { buildPlanForVariant } = await import('../../src/downloads/plan-builder.ts');
    const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT600S">
  <Period id="ad" duration="PT15S"><AdaptationSet contentType="video" mimeType="video/mp4">
    <SegmentTemplate media="ad-$Number$.m4s" timescale="1" duration="5"/>
    <Representation id="v" bandwidth="1000000" width="1280" height="720"/>
  </AdaptationSet></Period>
  <Period id="main" duration="PT585S"><AdaptationSet contentType="video" mimeType="video/mp4">
    <SegmentTemplate media="main-$Number$.m4s" timescale="1" duration="5"/>
    <Representation id="v" bandwidth="1000000" width="1280" height="720"/>
  </AdaptationSet></Period>
</MPD>`;
    const fetchImpl = (async () =>
      new Response(mpd, {
        status: 200,
        headers: { 'content-type': 'application/dash+xml' },
      })) as typeof fetch;
    const url = 'https://cdn.example/v/manifest.mpd';
    const candidate = {
      id: 'c',
      url,
      pageUrl: 'https://site.example/',
      kind: 'video',
      protocol: 'dash',
      format: 'mp4',
      source: 'network',
      seenAt: 0,
      tracks: { video: true, audio: false },
    } as const;
    const variant = {
      id: 'v',
      url,
      kind: 'video',
      protocol: 'dash',
      format: 'mp4',
      tracks: { video: true, audio: false },
      dashRepresentationId: 'v',
      dashAdaptationSetId: '0',
    } as const;
    await expect(buildPlanForVariant(candidate, variant, { fetchImpl })).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_MANIFEST,
      message: expect.stringContaining('2 separate parts'),
    });
  });

  it('regression: refuses a live HLS playlist instead of saving the window it lists', async () => {
    const { buildPlanForVariant } = await import('../../src/downloads/plan-builder.ts');
    // No ENDLIST, no VOD type: three segments of a stream still being written.
    // The scan calls this "live"; the download must refuse it the same way.
    const playlist =
      '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1200\n' +
      '#EXTINF:6,\ns1200.ts\n#EXTINF:6,\ns1201.ts\n#EXTINF:6,\ns1202.ts\n';
    const fetchImpl = (async () => new Response(playlist, { status: 200 })) as typeof fetch;
    const url = 'https://cdn.example/live/index.m3u8';
    const candidate = {
      id: 'c',
      url,
      pageUrl: 'https://site.example/',
      kind: 'video',
      protocol: 'hls',
      format: 'ts',
      source: 'network',
      seenAt: 0,
      tracks: { video: true, audio: true },
    } as const;
    const variant = {
      id: 'v',
      url,
      kind: 'video',
      protocol: 'hls',
      format: 'ts',
      tracks: { video: true, audio: true },
    } as const;
    await expect(buildPlanForVariant(candidate, variant, { fetchImpl })).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_MANIFEST,
      message: expect.stringContaining('live stream'),
    });
  });

  it('regression: refuses a live DASH manifest even when its timeline lists segments', async () => {
    const { buildPlanForVariant } = await import('../../src/downloads/plan-builder.ts');
    // A dynamic MPD whose SegmentTimeline names ten segments: the window the
    // server keeps right now, not the stream.
    const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z">
  <Period id="p" start="PT0S"><AdaptationSet contentType="video" mimeType="video/mp4">
    <SegmentTemplate media="v-$Time$.m4s" timescale="1">
      <SegmentTimeline><S t="0" d="4" r="9"/></SegmentTimeline>
    </SegmentTemplate>
    <Representation id="v" bandwidth="1000000" width="1280" height="720"/>
  </AdaptationSet></Period>
</MPD>`;
    const fetchImpl = (async () => new Response(mpd, { status: 200 })) as typeof fetch;
    const url = 'https://cdn.example/live/manifest.mpd';
    const candidate = {
      id: 'c',
      url,
      pageUrl: 'https://site.example/',
      kind: 'video',
      protocol: 'dash',
      format: 'mp4',
      source: 'network',
      seenAt: 0,
      tracks: { video: true, audio: false },
    } as const;
    const variant = {
      id: 'v',
      url,
      kind: 'video',
      protocol: 'dash',
      format: 'mp4',
      tracks: { video: true, audio: false },
      dashRepresentationId: 'v',
      // The id manifests/dash/parse.ts gives an AdaptationSet without one.
      dashAdaptationSetId: 'as0',
    } as const;
    await expect(buildPlanForVariant(candidate, variant, { fetchImpl })).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_MANIFEST,
      message: expect.stringContaining('live stream'),
    });
  });
});

describe('verification round: a server that ignores Range', () => {
  it('regression: refuses before reading the whole file into memory', async () => {
    let read = false;
    // highWaterMark 0: the stream is pulled only when someone reads the body.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true;
          controller.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    );
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-length': String(64 * 1024 * 1024) },
      })) as typeof fetch;
    await expect(
      fetchSegments({
        plan: {
          segments: [{ url: 'https://cdn.example/all.mp4', range: 'bytes=801-2000' }],
          totalDuration: 4,
          live: false,
        },
        retries: 0,
        signal: new AbortController().signal,
        fetchImpl,
      }).then((result) => result.firstError?.code),
    ).resolves.toBe(ErrorCode.INVALID_MEDIA);
    expect(read).toBe(false);
  });

  it('accepts a 200 that is exactly the whole range asked for', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array(1000), {
        status: 200,
        headers: { 'content-length': '1000' },
      })) as typeof fetch;
    const result = await fetchSegments({
      plan: {
        segments: [{ url: 'https://cdn.example/all.mp4', range: 'bytes=0-999' }],
        totalDuration: 4,
        live: false,
      },
      retries: 0,
      signal: new AbortController().signal,
      fetchImpl,
    });
    expect(result.failed).toEqual([]);
    expect(result.totalBytes).toBe(1000);
  });
});
