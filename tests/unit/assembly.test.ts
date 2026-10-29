/**
 * W8: assembly never holds the file twice, and gives back everything it
 * fetched when it does not finish.
 *
 * What a Node test can see is the shape: each segment reaches the assembler as
 * a Blob, the finished file is built from those Blobs, and no byte array is
 * kept. That the browser then composes the file by reference (one copy, not
 * two) is its implementation and stays a manual measurement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApi } from '../../src/browser/api.ts';
import { __setBrowserApi } from '../../src/browser/index.ts';
import { ErrorCode, MediaGrabError } from '../../src/core/errors.ts';
import { MAX_ASSEMBLY_BYTES } from '../../src/core/limits.ts';
import { assembleToObjectUrl } from '../../src/downloads/assembler.ts';
import { assemble } from '../../src/downloads/assembly-host.ts';
import { fetchSegments } from '../../src/downloads/segment-fetcher.ts';
import type { SegmentPlan } from '../../src/manifests/segment-plan.ts';
import { fromErrorResponse, toErrorResponse } from '../../src/offscreen/protocol.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';

const MIME = 'video/x-mediagrab-test';

function plan(count: number, host = 'cdn.example'): SegmentPlan {
  return {
    init: { url: `https://${host}/init.mp4` },
    segments: Array.from({ length: count }, (_unused, i) => ({
      url: `https://${host}/seg-${i}.m4s`,
      duration: 4,
    })),
    totalDuration: count * 4,
    live: false,
  };
}

/** Each segment's body is its own name; earlier segments answer later. */
function slowFirst(count: number): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const name = String(input).split('/').pop() ?? '';
    const index = name === 'init.mp4' ? -1 : Number(/seg-(\d+)/.exec(name)?.[1]);
    await new Promise((resolve) => setTimeout(resolve, (count - index) * 3));
    return new Response(new TextEncoder().encode(`[${name}]`), { status: 200 });
  }) as typeof fetch;
}

/** Everything reachable from `value` that is raw bytes rather than a Blob. */
function byteArraysIn(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (typeof value !== 'object' || value === null || seen.has(value)) return [];
  seen.add(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return [value];
  return Object.values(value).flatMap((child) => byteArraysIn(child, seen));
}

/** Records the Blob the assembler builds as the finished file, and the object URL made for it. */
function watchAssembly() {
  const OriginalBlob = globalThis.Blob;
  const finished: { parts: unknown[]; blob: Blob }[] = [];
  class WatchedBlob extends OriginalBlob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      if (options?.type === MIME) finished.push({ parts: [...(parts ?? [])], blob: this });
    }
  }
  vi.stubGlobal('Blob', WatchedBlob);
  const createObjectURL = vi.spyOn(URL, 'createObjectURL');
  return { finished, createObjectURL, OriginalBlob };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('W8: the file is held once', () => {
  it('W8: every segment comes back as a Blob, and the result keeps no byte arrays', async () => {
    const result = await fetchSegments({
      plan: plan(5),
      signal: new AbortController().signal,
      fetchImpl: slowFirst(5),
      retries: 0,
    });

    expect(result.parts).toHaveLength(6);
    expect(result.parts.every((part) => part instanceof Blob)).toBe(true);
    expect(byteArraysIn(result)).toEqual([]);
  });

  it('W8: the finished file is composed of the segment Blobs, init first, in playlist order', async () => {
    const { finished, createObjectURL, OriginalBlob } = watchAssembly();

    const result = await assembleToObjectUrl({
      plan: plan(6),
      mimeType: MIME,
      concurrency: 4,
      retries: 0,
      signal: new AbortController().signal,
      fetchImpl: slowFirst(6),
    });

    expect(finished).toHaveLength(1);
    const [file] = finished;
    // Blobs in - which the browser references - never byte arrays, which it copies.
    expect(file?.parts.every((part) => part instanceof OriginalBlob)).toBe(true);
    expect(byteArraysIn(file?.parts)).toEqual([]);
    // Segments finished last-first; the file is still in playlist order.
    expect(await file?.blob.text()).toBe(
      '[init.mp4][seg-0.m4s][seg-1.m4s][seg-2.m4s][seg-3.m4s][seg-4.m4s][seg-5.m4s]',
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledWith(file?.blob);
    expect(result.totalBytes).toBe(file?.blob.size);
    URL.revokeObjectURL(result.objectUrl);
  });

  it('W8: bytes and segments are still counted as each Blob arrives', async () => {
    const progress: Array<[number, number, number]> = [];
    const result = await fetchSegments({
      plan: plan(3),
      signal: new AbortController().signal,
      fetchImpl: slowFirst(3),
      retries: 0,
      onProgress: (bytes, done, total) => progress.push([bytes, done, total]),
    });

    const sizes = result.parts.map((part) => part.size);
    expect(result.totalBytes).toBe(sizes.reduce((sum, size) => sum + size, 0));
    expect(progress.map(([, done]) => done)).toEqual([1, 2, 3, 4]);
    expect(progress.at(-1)).toEqual([result.totalBytes, 4, 4]);
  });

  it('W8: the in-memory ceiling counts the Blobs and still refuses cleanly', async () => {
    // Two segments each just over half the ceiling. Blob sizes are faked:
    // the test must not allocate gigabytes.
    const half = Math.ceil(MAX_ASSEMBLY_BYTES / 2) + 1;
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        blob: async () => ({ size: half }) as Blob,
      }) as Response) as typeof fetch;

    await expect(
      fetchSegments({
        plan: { segments: plan(2).segments, totalDuration: 8, live: false },
        concurrency: 1,
        signal: new AbortController().signal,
        fetchImpl,
        retries: 0,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.DISK_ERROR });
  });
});

describe('W8: an assembly that does not finish keeps nothing', () => {
  it('W8: a cancelled assembly creates no object URL', async () => {
    const { createObjectURL } = watchAssembly();
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 3) controller.abort();
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;

    await expect(
      assembleToObjectUrl({
        plan: plan(10),
        mimeType: MIME,
        concurrency: 1,
        retries: 0,
        signal: controller.signal,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.CANCELLED });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('W8: a failed segment hands back no parts, and no object URL is made', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) =>
      String(input).endsWith('seg-2.m4s')
        ? new Response(null, { status: 404 })
        : new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch;

    const result = await fetchSegments({
      plan: plan(6),
      concurrency: 1,
      signal: new AbortController().signal,
      fetchImpl,
      retries: 0,
    });
    expect(result.failed).toEqual([3]);
    expect(result.parts).toEqual([]);

    const { createObjectURL } = watchAssembly();
    await expect(
      assembleToObjectUrl({
        plan: plan(6),
        mimeType: MIME,
        concurrency: 1,
        retries: 0,
        signal: new AbortController().signal,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MEDIA_NOT_FOUND });
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe('W8 (D18): a refusal names the host that refused', () => {
  const refusing = (status: number) =>
    (async () => new Response(null, { status })) as unknown as typeof fetch;

  it('W8: a 403 from a CDN on another host carries that host out of the assembler', async () => {
    const error = await assembleToObjectUrl({
      plan: plan(2, 'media-cdn.example'),
      mimeType: MIME,
      retries: 0,
      signal: new AbortController().signal,
      fetchImpl: refusing(403),
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MediaGrabError);
    expect(error).toMatchObject({ code: ErrorCode.STREAM_EXPIRED, host: 'media-cdn.example' });
  });

  it('W8: a 401 names its host; a 404 names none, since access would not help', async () => {
    const run = (status: number) =>
      assembleToObjectUrl({
        plan: plan(1, 'media-cdn.example'),
        mimeType: MIME,
        retries: 0,
        signal: new AbortController().signal,
        fetchImpl: refusing(status),
      }).then(
        () => undefined,
        (err: unknown) => err as MediaGrabError,
      );

    expect((await run(401))?.host).toBe('media-cdn.example');
    const notFound = await run(404);
    expect(notFound?.code).toBe(ErrorCode.MEDIA_NOT_FOUND);
    expect(notFound?.host).toBeUndefined();
  });

  it('W8: after a redirect, the host is the one that refused', async () => {
    const fetchImpl = (async () => {
      const response = new Response(null, { status: 403 });
      Object.defineProperty(response, 'url', { value: 'https://edge.other.example/seg-0.m4s' });
      return response;
    }) as typeof fetch;

    const result = await fetchSegments({
      plan: { segments: plan(1).segments, totalDuration: 4, live: false },
      signal: new AbortController().signal,
      fetchImpl,
      retries: 0,
    });
    expect(result.firstError?.host).toBe('edge.other.example');
  });

  it('W8: the host survives the offscreen round trip', () => {
    const error = new MediaGrabError(ErrorCode.STREAM_EXPIRED, 'Segment 1 of 3 ...', {
      detail: 'failed segment: https://media-cdn.example/seg-0.m4s',
      host: 'media-cdn.example',
    });

    // What crosses the message bus is structured-cloned data, not the Error.
    const rebuilt = fromErrorResponse(structuredClone(toErrorResponse(error)));
    expect(rebuilt).toBeInstanceOf(MediaGrabError);
    expect(rebuilt).toMatchObject({
      code: ErrorCode.STREAM_EXPIRED,
      message: error.message,
      detail: error.detail,
      host: 'media-cdn.example',
    });
    expect(fromErrorResponse(undefined)).toMatchObject({ code: ErrorCode.INTERNAL });
  });
});

describe('verification round: a stop while the offscreen document is being made', () => {
  it('never sends the stream to the document (Chrome: no createObjectURL in the worker)', async () => {
    const controller = new AbortController();
    const api = createFakeBrowserApi();
    const sent: unknown[] = [];
    api.offscreen = {
      isSupported: () => true,
      ensureDocument: async () => controller.abort(), // the user stops it meanwhile
      close: async () => undefined,
    };
    api.runtime.request = async (message) => {
      sent.push(message);
      return { ok: true, objectUrl: 'blob:x', totalBytes: 1 };
    };
    __setBrowserApi(api as BrowserApi);
    const createObjectURL = URL.createObjectURL;
    // A service worker has none; that is what sends assembly to the document.
    (URL as { createObjectURL?: unknown }).createObjectURL = undefined;
    try {
      await expect(
        assemble({
          taskId: 't',
          plan: { segments: [], totalDuration: 0, live: false } as unknown as SegmentPlan,
          mimeType: 'video/mp2t',
          concurrency: 1,
          retries: 0,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CANCELLED });
    } finally {
      URL.createObjectURL = createObjectURL;
      __setBrowserApi(null);
    }
    expect(sent).toEqual([]);
  });
});
