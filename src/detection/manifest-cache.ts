/**
 * Manifests fetched recently, by normalized URL.
 *
 * Scans come in bursts - every page report and every media request can start
 * one - and each scan expands up to MAX_MANIFEST_EXPANSIONS manifests, then
 * reads each HLS master's best rendition playlist once more (engine.ts, D21).
 * Without this, one page load fetched the same master playlist a dozen times.
 * A manifest's ladder does not change in half a minute, nor does whether a
 * playlist is encrypted, finished or how long it is. A live playlist's
 * segment list does change, but nothing is saved from it: detection only
 * counts segments, and the download rebuilds its plan from a fresh fetch
 * (plan-builder.ts).
 *
 * Failures are not remembered: a timeout now says nothing about the next try.
 * Lives as long as the worker, which is never long.
 */
import type { MediaCandidate } from '../core/types.ts';
import { normalizeUrl } from '../media/fingerprint.ts';
import { type LoadOptions, loadManifestDetails, type ManifestDetails } from './manifest-loader.ts';

const TTL_MS = 30_000;
/** Distinct manifests remembered; a page rarely has more than a handful. */
const MAX_ENTRIES = 32;

type Loader = (candidate: MediaCandidate) => Promise<ManifestDetails>;

export class ManifestCache {
  private readonly entries = new Map<string, { at: number; details: Promise<ManifestDetails> }>();

  constructor(
    private readonly load: Loader = (candidate) =>
      loadManifestDetails(candidate.url, candidate.protocol),
    private readonly now: () => number = Date.now,
  ) {}

  details(candidate: MediaCandidate): Promise<ManifestDetails> {
    const key = normalizeUrl(candidate.url);
    const cached = this.entries.get(key);
    if (cached && this.now() - cached.at < TTL_MS) return cached.details;

    const details = this.load(candidate);
    this.entries.delete(key); // re-inserted last, so eviction takes the oldest
    this.entries.set(key, { at: this.now(), details });
    details.catch(() => {
      if (this.entries.get(key)?.details === details) this.entries.delete(key);
    });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return details;
  }
}

/** A cache-less loader, for tests and one-off scans. */
export function uncachedLoader(options: LoadOptions = {}): Loader {
  return (candidate) => loadManifestDetails(candidate.url, candidate.protocol, options);
}
