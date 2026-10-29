/**
 * Manifest-relative URL resolution. HLS URIs resolve against the playlist's
 * URL (RFC 8216 s4.1), DASH BaseURLs against the enclosing BaseURL or the MPD's
 * URL (ISO/IEC 23009-1 5.6.4); both are plain RFC 3986 resolution.
 *
 * Arguments in the order `new URL` takes them: the reference, then the base.
 * Undefined when either is not a usable URL; the caller decides whether to
 * keep the reference as written (so the failure surfaces as a clear fetch
 * error on that URL) or to fall back to the base.
 */
export function resolveUrl(reference: string, base: string): string | undefined {
  try {
    return new URL(reference, base).toString();
  } catch {
    return undefined;
  }
}
