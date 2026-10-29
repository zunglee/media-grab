/**
 * Poster back-fill.
 *
 * Only a `<video>` element carries a poster attribute. The candidate a user
 * actually wants is usually the HLS master or the DASH manifest, and those are
 * found by the network observer, which sees a URL and two headers and nothing
 * else. So without this, the row the user is most likely to download is the one
 * row with no picture, which reads as broken rather than as "no poster".
 *
 * The rule is deliberately conservative: a candidate inherits a poster only
 * from the same page, and only when it has none of its own. Pure, so it is
 * tested without a browser.
 */
import type { MediaCandidate } from '../core/types.ts';

export interface BackfillOptions {
  /** Page-level poster: og:image, twitter:image, or a JSON-LD thumbnailUrl. */
  pagePoster?: string;
}

/**
 * Returns new candidates with `posterUrl` filled in where it was missing.
 * Never overwrites a poster a candidate already has.
 */
export function backfillPosters(
  candidates: MediaCandidate[],
  options: BackfillOptions = {},
): MediaCandidate[] {
  const byPage = new Map<string, string>();

  // Prefer a poster that came from a real media element on that page over the
  // page-level metadata one: it is the frame the player is actually showing.
  for (const candidate of candidates) {
    if (!isUsablePoster(candidate.posterUrl)) continue;
    if (!byPage.has(candidate.pageUrl)) byPage.set(candidate.pageUrl, candidate.posterUrl);
  }

  return candidates.map((candidate) => {
    if (isUsablePoster(candidate.posterUrl)) return candidate;
    if (candidate.kind === 'image' || candidate.kind === 'subtitle') return candidate;

    const inherited = byPage.get(candidate.pageUrl) ?? options.pagePoster;
    if (!isUsablePoster(inherited)) return candidate;
    return { ...candidate, posterUrl: inherited };
  });
}

/**
 * An absolute http(s) URL with a host. That rules out a `data:` poster, which is
 * usually a 1px placeholder the player swaps out later, and relative or empty
 * attribute values we cannot resolve here.
 */
function isUsablePoster(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return (protocol === 'http:' || protocol === 'https:') && hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Pick the page-level poster from the metadata a page advertises, in the order
 * that is most likely to be the real key frame.
 */
export function choosePagePoster(candidates: Array<string | undefined>): string | undefined {
  return candidates.find(isUsablePoster);
}
