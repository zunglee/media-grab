/**
 * Waiting and retrying, shared by everything in a download that talks to a
 * server: the segment fetcher (per segment) and the segmented engine (the
 * media playlist or MPD it fetches before any segment).
 *
 * Only failures that can pass are retried (`MediaGrabError.retryable`: a
 * dropped connection, a 5xx, a 429). A 404 or a 403 will not change on the
 * fourth attempt; retrying it only delays the error the user needs to see.
 */
import { ErrorCode, MediaGrabError, toMediaGrabError } from '../core/errors.ts';

const BASE_BACKOFF_MS = 400;
export const MAX_BACKOFF_MS = 15_000;

/** Full jitter, so a thousand segments do not retry in lockstep. */
export function backoffMs(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.round(Math.random() * ceiling);
}

/** Resolves after `ms`; rejects with CANCELLED as soon as `signal` aborts. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new MediaGrabError(ErrorCode.CANCELLED, 'Cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MediaGrabError(ErrorCode.CANCELLED, 'Cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `work`, tried up to `retries` more times while it fails in a way that can pass. */
export async function retrying<T>(
  work: () => Promise<T>,
  options: { retries: number; signal: AbortSignal },
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      const error = toMediaGrabError(err);
      if (options.signal.aborted || !error.retryable || attempt >= options.retries) throw error;
      await delay(backoffMs(attempt), options.signal);
    }
  }
}
