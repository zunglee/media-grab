/**
 * The generic adapter: what runs on every site that has no adapter of its own.
 *
 * It adds no candidates - the detection engine already did that. What it does
 * is the site-agnostic tidying that would otherwise be scattered through the
 * engine: give unnamed media the page's title, and prefer the rendition whose
 * duration matches the page's main player when several unrelated videos are on
 * one page (ads and trailers usually differ in length from the feature).
 */
import type { MediaCandidate } from '../../core/types.ts';
import { cleanTitle } from '../../media/naming.ts';
import { BaseAdapter } from '../types.ts';

class GenericAdapter extends BaseAdapter {
  id = 'generic';
  name = 'Generic detection';
  hosts: string[] = [];

  override matches(): boolean {
    return true;
  }

  override rank(candidates: MediaCandidate[]): MediaCandidate[] {
    const dominant = dominantDuration(candidates);
    if (dominant === undefined) return candidates;

    // Nudge, do not overrule: +6 is enough to break a tie between the feature
    // and a similarly-scored trailer, but cannot promote a thumbnail.
    return [...candidates]
      .map((candidate) => {
        if (candidate.duration === undefined) return candidate;
        const matchesMain = Math.abs(candidate.duration - dominant) <= Math.max(2, dominant * 0.02);
        if (!matchesMain) return candidate;
        return {
          ...candidate,
          score: Math.min(100, (candidate.score ?? 0) + 6),
          scoreReasons: [...(candidate.scoreReasons ?? []), '+6 duration matches the main player'],
        };
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  override normalize(candidate: MediaCandidate): MediaCandidate {
    if (candidate.title) return candidate;
    const title = candidate.pageTitle
      ? cleanTitle(candidate.pageTitle, candidate.pageUrl)
      : undefined;
    return title ? { ...candidate, title } : candidate;
  }
}

/**
 * The duration shared by the most candidates, which is almost always the media
 * the user is looking at (the same video appears as several renditions).
 */
function dominantDuration(candidates: MediaCandidate[]): number | undefined {
  const buckets = new Map<number, number>();
  for (const candidate of candidates) {
    if (candidate.duration === undefined || candidate.duration < 10) continue;
    const bucket = Math.round(candidate.duration);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  let best: { duration: number; count: number } | undefined;
  for (const [duration, count] of buckets) {
    if (!best || count > best.count || (count === best.count && duration > best.duration)) {
      best = { duration, count };
    }
  }
  return best && best.count >= 2 ? best.duration : undefined;
}

export const genericAdapter = new GenericAdapter();
