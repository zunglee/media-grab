/**
 * Regression tests for B12 (tokens redaction missed) and B23 (the manifest
 * size cap was checked only after the whole body had been read).
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode, MediaGrabError } from '../../src/core/errors.ts';
import { fetchManifestText } from '../../src/core/fetch.ts';
import { redactUrl } from '../../src/core/redact.ts';

describe('B12 redaction of tokens outside the obvious query parameters', () => {
  it('redacts an Akamai path token and keeps the rest of the path (proof X3)', () => {
    const hmac = '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
    const out = redactUrl(
      `https://x.akamaized.net/hls/live/1/hdntl=exp=1700000000~acl=%2f*~data=hdntl~hmac=${hmac}/index.m3u8`,
    );
    expect(out).not.toContain(hmac);
    expect(out).not.toContain('exp=1700000000');
    expect(out).toBe('https://x.akamaized.net/hls/live/1/hdntl=REDACTED/index.m3u8');
  });

  it('redacts a JWT path segment (Cloudflare Stream signed URL, proof X3)', () => {
    const jwt =
      'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJ2aWQiLCJleHAiOjE3MDAwMDAwMDB9.c2lnbmF0dXJlc2lnbmF0dXJl';
    expect(redactUrl(`https://customer-abc.cloudflarestream.com/${jwt}/manifest/video.m3u8`)).toBe(
      'https://customer-abc.cloudflarestream.com/REDACTED/manifest/video.m3u8',
    );
  });

  it('redacts tokens inside a URL nested in a query value (proof X3)', () => {
    const out = redactUrl(
      'https://player.example/embed?src=https%3A%2F%2Fcdn.example%2Fv.m3u8%3Ftoken%3DSECRET123',
    );
    expect(out).not.toContain('SECRET123');
    const nested = new URL(out).searchParams.get('src');
    expect(nested).toBe('https://cdn.example/v.m3u8?token=REDACTED');
  });

  it('redacts long hex and base64url segments and values, whatever their name', () => {
    expect(redactUrl(`https://cdn.example/${'ab12'.repeat(8)}/v.mp4`)).toBe(
      'https://cdn.example/REDACTED/v.mp4',
    );
    expect(redactUrl('https://cdn.example/550e8400-e29b-41d4-a716-446655440000/v.mp4')).toBe(
      'https://cdn.example/REDACTED/v.mp4',
    );
    expect(redactUrl('https://cdn.example/v.mp4?p=Zx9_kQ2mT8vR4bN1cL7hW3sY6dF0gJ5a')).toBe(
      'https://cdn.example/v.mp4?p=REDACTED',
    );
    expect(redactUrl('https://b.s3.example/v.mp4?X-Amz-Signature=abc&X-Amz-Credential=AKIA')).toBe(
      'https://b.s3.example/v.mp4?X-Amz-Signature=REDACTED&X-Amz-Credential=REDACTED',
    );
  });

  it('redacts sensitive matrix parameters in a path segment', () => {
    expect(redactUrl('https://site.example/watch;jsessionid=ABC123/v.mp4')).toBe(
      'https://site.example/watch;jsessionid=REDACTED/v.mp4',
    );
  });

  it('keeps what a report needs: slugs, short ids and file names', () => {
    const url =
      'https://cdn.example/videos/how-to-build-a-startup-in-2026-part-one/dQw4w9WgXcQ/master.m3u8?quality=hd';
    expect(redactUrl(url)).toBe(url);
  });
});

/** A body that never ends, counting how many chunks were pulled from it. */
function endlessBody(chunkBytes: number): {
  body: ReadableStream<Uint8Array>;
  pulled: () => number;
} {
  let pulled = 0;
  const chunk = new Uint8Array(chunkBytes).fill(35);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
    },
  });
  return { body, pulled: () => pulled };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err instanceof MediaGrabError ? err.code : 'not a MediaGrabError';
  }
}

describe('B23 the 8 MiB manifest cap holds while reading', () => {
  const MiB = 1024 * 1024;

  it('stops reading a body with no Content-Length just past the cap (proof X4)', async () => {
    const { body, pulled } = endlessBody(MiB);
    const fetchImpl = async () => new Response(body, { status: 200 });
    const code = await codeOf(
      fetchManifestText('https://x.example/m.m3u8', { timeoutMs: 10_000, fetchImpl }),
    );
    expect(code).toBe(ErrorCode.UNSUPPORTED_MANIFEST);
    // 8 MiB fit, the 9th MiB trips the cap; a stream may prefetch one more.
    expect(pulled()).toBeLessThanOrEqual(10);
  });

  it('refuses without reading when Content-Length admits the size', async () => {
    const { body, pulled } = endlessBody(MiB);
    const fetchImpl = async () =>
      new Response(body, { status: 200, headers: { 'content-length': String(9 * MiB) } });
    const code = await codeOf(
      fetchManifestText('https://x.example/m.m3u8', { timeoutMs: 10_000, fetchImpl }),
    );
    expect(code).toBe(ErrorCode.UNSUPPORTED_MANIFEST);
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it('decodes UTF-8 split across chunks exactly like response.text()', async () => {
    const bytes = new TextEncoder().encode('#EXTM3U\n#EXT-X-MEDIA:NAME="Français 日本語"\n');
    const split = bytes.indexOf(0xc3) + 1; // inside the two-byte "ç"
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    const fetchImpl = async () => new Response(body, { status: 200 });
    const text = await fetchManifestText('https://x.example/m.m3u8', {
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(text).toBe('#EXTM3U\n#EXT-X-MEDIA:NAME="Français 日本語"\n');
  });

  it('keeps the error classification: HTTP status, timeout, caller abort', async () => {
    const notFound = async () => new Response('gone', { status: 404 });
    expect(
      await codeOf(
        fetchManifestText('https://x.example/m', { timeoutMs: 1000, fetchImpl: notFound }),
      ),
    ).toBe(ErrorCode.MEDIA_NOT_FOUND);

    // A server that sends headers, then stalls mid-body until the timeout.
    const stalled = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('#EXTM3U\n'));
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return new Response(body, { status: 200 });
    };
    expect(
      await codeOf(fetchManifestText('https://x.example/m', { timeoutMs: 20, fetchImpl: stalled })),
    ).toBe(ErrorCode.NETWORK_ERROR);

    const caller = new AbortController();
    const pending = fetchManifestText('https://x.example/m', {
      timeoutMs: 10_000,
      signal: caller.signal,
      fetchImpl: stalled,
    });
    caller.abort();
    expect(await codeOf(pending)).toBe(ErrorCode.CANCELLED);
  });
});

describe('re-audit: short signature parameters', () => {
  it('redacts nginx secure_link and st/e signatures', () => {
    const md5 = redactUrl(
      'https://cdn.example/v.mp4?md5=AbCdEfGhIjKlMnOpQrStUv&expires=1700000000',
    );
    expect(md5).not.toContain('AbCdEfGhIjKlMnOpQrStUv');
    const st = redactUrl('https://cdn.example/v.mp4?st=AbCdEfGhIjKlMnOpQrStUv&e=1700000000');
    expect(st).not.toContain('AbCdEfGhIjKlMnOpQrStUv');
    expect(st).not.toContain('1700000000');
  });

  it('keeps harmless short parameters', () => {
    expect(redactUrl('https://site.example/watch?v=abc123&t=90')).toContain('v=abc123');
  });
});
