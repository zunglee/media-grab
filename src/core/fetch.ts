/**
 * Network helpers shared by detection (expanding a manifest during a scan) and
 * downloads (rebuilding the segment plan when the user clicks download).
 */
import { codeForHttpStatus, ErrorCode, MediaGrabError } from './errors.ts';

/**
 * How long a manifest fetch may take. Manifests are small text files; one
 * that takes longer than this is on a server that will not serve the segments
 * either. Shared by detection and download, so they judge a server alike.
 */
export const MANIFEST_TIMEOUT_MS = 15_000;

/**
 * `fetch` must keep its receiver. Assigning it to a bare variable detaches it,
 * which a service worker tolerates but a Window does not - inside the offscreen
 * document a detached call throws
 * "Failed to execute 'fetch' on 'Window': Illegal invocation",
 * which is how every segmented download used to fail on Chrome.
 */
export function boundFetch(override?: typeof fetch): typeof fetch {
  return override ?? ((input, init) => globalThis.fetch(input, init));
}

/** Manifests are text; a response larger than this is not one. */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export interface ManifestFetchOptions {
  /** The caller's own abort, e.g. the user pausing a download. */
  signal?: AbortSignal;
  timeoutMs: number;
  /** Injected by unit tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch an HLS playlist or a DASH MPD as text.
 *
 * Always without credentials: a manifest that needs the user's cookies is one
 * we are not entitled to fetch on their behalf outside the page, and refusing
 * here is what keeps the "we do not bypass sign-in" promise honest.
 *
 * Anything over 8 MiB is refused: no real playlist is that large, and reading
 * one into memory is how a hostile server would try to stall the worker. The
 * cap is enforced while reading, not after: a chunked or gzip-compressed
 * response has no Content-Length that tells the truth, so the body is counted
 * as it arrives and the read is cancelled the moment it passes the cap.
 *
 * Failures are classified so callers never have to guess:
 *   caller aborted  -> CANCELLED (never retried, never shown as an error)
 *   timed out       -> NETWORK_ERROR
 *   HTTP 4xx / 5xx  -> the same code a segment failure would get
 */
export async function fetchManifestText(
  url: string,
  options: ManifestFetchOptions,
): Promise<string> {
  const doFetch = boundFetch(options.fetchImpl);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs);
  const signal = options.signal ? anySignal([options.signal, timeout.signal]) : timeout.signal;

  try {
    const response = await doFetch(url, { credentials: 'omit', redirect: 'follow', signal });
    if (!response.ok) {
      throw new MediaGrabError(
        codeForHttpStatus(response.status),
        `Manifest fetch failed with HTTP ${response.status}`,
        // The host that answered, after any redirect: the one a grant must name.
        { httpStatus: response.status, host: hostOf(response.url || url) },
      );
    }
    // Fast path: refuse before reading when the server admits the size.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) throw tooLarge();
    return await readTextWithin(response, MAX_MANIFEST_BYTES);
  } catch (err) {
    if (options.signal?.aborted) {
      throw new MediaGrabError(ErrorCode.CANCELLED, 'Cancelled', { cause: err });
    }
    if (err instanceof MediaGrabError) throw err;
    if (timeout.signal.aborted) {
      throw new MediaGrabError(ErrorCode.NETWORK_ERROR, 'Manifest fetch timed out');
    }
    throw new MediaGrabError(ErrorCode.NETWORK_ERROR, 'Manifest fetch failed', { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

function tooLarge(): MediaGrabError {
  return new MediaGrabError(ErrorCode.UNSUPPORTED_MANIFEST, 'Manifest is implausibly large');
}

/**
 * The body as UTF-8 text (what `response.text()` would give), counting
 * decompressed bytes as they arrive and cancelling the stream past `maxBytes`,
 * so an endless or bomb-sized body costs at most `maxBytes` of memory.
 */
async function readTextWithin(response: Response, maxBytes: number): Promise<string> {
  // No stream (an empty 204, or a test double): nothing to count.
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      // Tell the server we are done; do not wait for it to agree.
      reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** `AbortSignal.any` is not available everywhere yet; this is the fallback. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const withAny = AbortSignal as typeof AbortSignal & {
    any?: (list: AbortSignal[]) => AbortSignal;
  };
  if (typeof withAny.any === 'function') return withAny.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
