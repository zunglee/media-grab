/**
 * Segment fetching for HLS/DASH downloads (PRD s38, s39).
 *
 * Design notes:
 *  - Order is preserved by writing into a fixed-size array by index, not by
 *    pushing in completion order. Concatenating segments out of order produces
 *    a file that plays for two seconds and then breaks.
 *  - Concurrency is adaptive but bounded: it starts at the user's "parallel
 *    segments" setting, halves on a 429 or a 5xx, and grows back while segments
 *    succeed - never above that setting. "Use 20 connections" is how you get
 *    rate-limited by a CDN and blamed for it.
 *  - Retries use exponential backoff with jitter, and honour Retry-After. Only
 *    failures that can pass are retried: a 404 or a 403 will not change on the
 *    fourth attempt, it only delays the error the user needs to see.
 *  - A ranged request must come back 206. A server that ignores Range answers
 *    200 with the whole resource, and using that as one segment would write a
 *    silently corrupt file many times the right size.
 *  - Credentials are omitted. A segment that needs the user's cookies is one we
 *    should not be fetching from the background.
 *  - The first segment that fails every retry stops the whole fetch. A file
 *    with a gap is refused anyway, so there is no point downloading the rest.
 *
 * Memory: the file must never be held twice. Through 0.1.5 each segment was
 * read into a typed array and the assembler built the file with
 * `new Blob(parts)`, which copies bytes: at the peak the page held every
 * segment as an ArrayBuffer AND the finished Blob - two full copies, up to
 * 2 x MAX_ASSEMBLY_BYTES - and the arrays went only when the garbage collector
 * got to them. Now each segment becomes a Blob the moment it arrives
 * (`response.blob()`: the body goes into the browser's blob storage, which can
 * page to disk, and never sits in this page's heap as bytes), and the finished
 * file is `new Blob(blobs)`, which refers to those parts instead of copying
 * them. Peak: one copy of the file, plus the segments in flight. Composing by
 * reference is how Chrome's blob storage and Firefox's multipart blobs work,
 * which a Node unit test cannot observe: the tests pin the shape (Blobs in, no
 * byte arrays kept) and the peak itself is a manual check.
 *
 * Failure and cancel release everything: a cancel throws and a failed segment
 * returns no parts, so nothing fetched outlives the call.
 */
import {
  codeForHttpStatus,
  ErrorCode,
  isRetryable,
  MediaGrabError,
  toMediaGrabError,
} from '../core/errors.ts';
import { boundFetch } from '../core/fetch.ts';
import { MAX_ASSEMBLY_BYTES } from '../core/limits.ts';
import { createLogger } from '../core/log.ts';
import type { Segment, SegmentPlan } from '../manifests/segment-plan.ts';
import { backoffMs, delay, MAX_BACKOFF_MS } from './retry.ts';

const log = createLogger('segments');

export const DEFAULT_CONCURRENCY = 4;
/** The settings page offers 1-8; a larger value is treated as 8. */
const MAX_CONCURRENCY = 8;
const MIN_CONCURRENCY = 1;
/** Clean segments in a row before one more connection is opened. */
const GROW_AFTER_SUCCESSES = 8;
const SEGMENT_TIMEOUT_MS = 60_000;

export interface FetchSegmentsOptions {
  plan: SegmentPlan;
  /** 0 means "decide automatically". */
  concurrency?: number;
  retries?: number;
  signal: AbortSignal;
  onProgress?: (receivedBytes: number, segmentsDone: number, segmentsTotal: number) => void;
  fetchImpl?: typeof fetch;
}

export interface FetchSegmentsResult {
  /**
   * One Blob per segment, init segment first, then playlist order. Blobs, not
   * byte arrays, so the finished file can reference them (see the header).
   * Empty when a segment failed: nothing fetched is kept for a file that will
   * not be saved.
   */
  parts: Blob[];
  totalBytes: number;
  /**
   * Segments that failed every retry. Non-empty means the file is incomplete,
   * and fetching stopped at the first one: a file with a hole in it is never
   * saved (assembler.ts), so every byte fetched after the hole would be wasted.
   */
  failed: number[];
  /**
   * Why the first failure happened. Without it a caller can only report
   * "N segments could not be downloaded", which is exactly the generic failure
   * message this product exists to avoid. `host` is set for a 401/403: the
   * server that refused, so the user can be offered access to it (D18).
   */
  firstError?: { code: ErrorCode; message: string; url: string; host?: string };
}

export async function fetchSegments(options: FetchSegmentsOptions): Promise<FetchSegmentsResult> {
  const doFetch = boundFetch(options.fetchImpl);
  const retries = options.retries ?? 3;
  const all: Segment[] = options.plan.init
    ? [options.plan.init, ...options.plan.segments]
    : [...options.plan.segments];
  if (all.length === 0) {
    throw new MediaGrabError(
      ErrorCode.UNSUPPORTED_MANIFEST,
      'The manifest produced no segments to download',
    );
  }

  // Stops every worker: the caller aborting, or a failure that dooms the file.
  const halt = new AbortController();
  const forwardAbort = () => halt.abort();
  options.signal.addEventListener('abort', forwardAbort, { once: true });
  if (options.signal.aborted) halt.abort();

  const parts = new Array<Blob>(all.length);
  const failed: number[] = [];
  let firstError: FetchSegmentsResult['firstError'];
  let fatal: MediaGrabError | undefined;
  let received = 0;
  let done = 0;
  let next = 0;
  // The user's setting is a ceiling, not just a starting point: someone who
  // picks 1 to be gentle on a CDN must not find 8 connections open later.
  const ceiling = Math.min(
    MAX_CONCURRENCY,
    options.concurrency && options.concurrency > 0 ? options.concurrency : DEFAULT_CONCURRENCY,
  );
  let concurrency = ceiling;
  let consecutiveSuccesses = 0;

  /**
   * A slot in the pool. `workerIndex >= concurrency` means the pool has shrunk
   * past this slot, so the worker parks instead of exiting - that way a later
   * concurrency increase brings it back without respawning anything.
   */
  const runWorker = async (workerIndex: number): Promise<void> => {
    while (!halt.signal.aborted) {
      if (next >= all.length) return;
      if (workerIndex >= concurrency) {
        await sleep(250, halt.signal);
        continue;
      }

      const index = next;
      next += 1;
      const segment = all[index];
      if (!segment) continue;

      try {
        const part = await fetchOne(segment, {
          doFetch,
          retries,
          signal: halt.signal,
          onRateLimited: () => {
            concurrency = Math.max(MIN_CONCURRENCY, Math.floor(concurrency / 2));
            consecutiveSuccesses = 0;
            log.debug(`rate limited; concurrency now ${concurrency}`);
          },
        });

        // A segment that lands after the fetch was stopped is not kept.
        if (halt.signal.aborted) return;
        parts[index] = part;
        received += part.size;
        done += 1;
        consecutiveSuccesses += 1;

        if (received > MAX_ASSEMBLY_BYTES) {
          fatal = new MediaGrabError(
            ErrorCode.DISK_ERROR,
            'This download is too large to assemble in the browser (over 1.5 GB).',
          );
          halt.abort();
          return;
        }

        // Recover slowly after a rate limit, back up to the ceiling.
        if (consecutiveSuccesses >= GROW_AFTER_SUCCESSES && concurrency < ceiling) {
          concurrency += 1;
          consecutiveSuccesses = 0;
        }

        options.onProgress?.(received, done, all.length);
      } catch (err) {
        if (halt.signal.aborted) return; // stopped by the caller or by another worker
        const error = toMediaGrabError(err, ErrorCode.SEGMENT_FAILED);
        firstError ??= {
          code: error.code,
          message: error.message,
          url: segment.url,
          ...(error.host ? { host: error.host } : {}),
        };
        failed.push(index);
        log.warn(`segment ${index} failed; stopping`, error.message);
        halt.abort();
        return;
      }
    }
  };

  try {
    const poolSize = Math.min(ceiling, all.length);
    await Promise.all(Array.from({ length: poolSize }, (_unused, slot) => runWorker(slot)));
  } finally {
    options.signal.removeEventListener('abort', forwardAbort);
  }

  if (options.signal.aborted) {
    throw new MediaGrabError(ErrorCode.CANCELLED, 'Download cancelled');
  }
  if (fatal) throw fatal;

  return {
    // A file with a hole is never saved, so a failure hands nothing back: the
    // parts are released here rather than held while the caller builds its error.
    parts: failed.length > 0 ? [] : parts.filter((part): part is Blob => part !== undefined),
    totalBytes: received,
    failed,
    ...(firstError ? { firstError } : {}),
  };
}

interface FetchOneOptions {
  doFetch: typeof fetch;
  retries: number;
  signal: AbortSignal;
  onRateLimited: () => void;
}

async function fetchOne(segment: Segment, options: FetchOneOptions): Promise<Blob> {
  let lastError: MediaGrabError | null = null;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    if (options.signal.aborted) throw new MediaGrabError(ErrorCode.CANCELLED, 'Cancelled');

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), SEGMENT_TIMEOUT_MS);
    const onAbort = () => timeout.abort();
    options.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const headers: Record<string, string> = {};
      if (segment.range) headers.Range = segment.range;
      // No Referer here: `fetch` drops it (a forbidden header). The page is
      // named by a session declarativeNetRequest rule the task holds for this
      // host (downloads/referer-rules.ts, ARCHITECTURE.md D18).

      const response = await options.doFetch(segment.url, {
        credentials: 'omit',
        redirect: 'follow',
        signal: timeout.signal,
        headers,
      });

      if (!response.ok) {
        const code = codeForHttpStatus(response.status);
        if (response.status === 429 || response.status >= 500) options.onRateLimited();
        const host = refusingHost(response, segment.url);
        lastError = new MediaGrabError(code, `Segment failed with HTTP ${response.status}`, {
          httpStatus: response.status,
          ...(host ? { host } : {}),
        });
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        if (attempt < options.retries && isRetryable(code)) {
          await delay(retryAfter ?? backoffMs(attempt), options.signal);
          continue;
        }
        throw lastError;
      }

      // Decided before the body is read: a server that ignores Range sends the
      // whole file for every piece, and reading it just to refuse it could put
      // several copies of a large file in memory.
      if (segment.range && response.status !== 206 && !isWholeRange(segment.range, response)) {
        void response.body?.cancel().catch(() => undefined);
        throw new MediaGrabError(
          ErrorCode.INVALID_MEDIA,
          `The server ignored the byte range for a segment (HTTP ${response.status} instead of 206)`,
        );
      }
      // Straight into a Blob: the bytes never become an ArrayBuffer in this
      // page (see the header). Awaited here so the timeout covers the body.
      return await response.blob();
    } catch (err) {
      if (options.signal.aborted) throw new MediaGrabError(ErrorCode.CANCELLED, 'Cancelled');
      if (err instanceof MediaGrabError && !isRetryable(err.code)) throw err;
      lastError =
        err instanceof MediaGrabError
          ? err
          : new MediaGrabError(
              ErrorCode.SEGMENT_FAILED,
              // Keep the underlying reason: "Segment request failed" on its own
              // is the generic message this product refuses to ship.
              `Segment request failed: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
      if (attempt < options.retries) {
        await delay(backoffMs(attempt), options.signal);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
    }
  }

  throw lastError ?? new MediaGrabError(ErrorCode.SEGMENT_FAILED, 'Segment failed');
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(MAX_BACKOFF_MS, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(MAX_BACKOFF_MS, Math.max(0, date - Date.now()));
  return undefined;
}

/**
 * The host that answered 401 or 403 - after redirects, the one that actually
 * refused - for the failed row's "Allow <host> and retry" (ARCHITECTURE.md
 * D18). Other failures are not about access, so they name no host.
 */
function refusingHost(response: Response, segmentUrl: string): string | undefined {
  if (response.status !== 401 && response.status !== 403) return undefined;
  try {
    return new URL(response.url || segmentUrl).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Abort-aware sleep that resolves (rather than rejecting) on abort. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, signal).catch(() => undefined);
}

/**
 * A 200 answer to a ranged request is still right when the range asked for the
 * whole resource from its first byte: `bytes=0-999` answered with a
 * Content-Length of exactly 1000. Any other 200 is the whole file where one
 * piece was wanted.
 */
function isWholeRange(range: string, response: Response): boolean {
  const match = /^bytes=0-(\d+)$/.exec(range);
  const length = Number(response.headers.get('content-length'));
  return match !== null && length === Number(match[1]) + 1;
}
