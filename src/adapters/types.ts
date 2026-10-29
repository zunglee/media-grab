import type { MediaCandidate } from '../core/types.ts';

/**
 * Site adapter contract (PRD s17).
 *
 * An adapter is an OPTIONAL refinement layer. The generic engine runs first and
 * always produces its own results; an adapter may add candidates it knows how
 * to find and re-order the list using site knowledge. It may not remove the
 * generic results, and it may not be the only source of a download.
 *
 * Adapters run in the background worker with the same permissions as the rest
 * of the extension. That is why this build ships only bundled, reviewed
 * adapters: see ARCHITECTURE.md "Adapter distribution" for why remote adapter
 * loading is deliberately not implemented yet.
 */
export interface AdapterContext {
  pageUrl: string;
  pageTitle: string;
  /** Everything the generic engine has found so far. */
  candidates: MediaCandidate[];
}

export interface SiteAdapter {
  /** Stable identifier, used in diagnostics and the compatibility list. */
  id: string;
  /** Human-readable name for the settings screen. */
  name: string;
  /** Hostnames this adapter claims, matched as suffixes (`vimeo.com`). */
  hosts: string[];
  matches(url: string): boolean;
  /** Additional candidates. Must not throw; the engine catches, but still. */
  detect(context: AdapterContext): Promise<MediaCandidate[]>;
  /** Re-order using site knowledge. Must return the same set, reordered. */
  rank(candidates: MediaCandidate[]): MediaCandidate[];
  /** Fix up a candidate's metadata (title, language, poster). */
  normalize(candidate: MediaCandidate): MediaCandidate;
}

/** Base implementation so an adapter only overrides what it actually knows. */
export abstract class BaseAdapter implements SiteAdapter {
  abstract id: string;
  abstract name: string;
  abstract hosts: string[];

  matches(url: string): boolean {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    return this.hosts.some((claimed) => host === claimed || host.endsWith(`.${claimed}`));
  }

  async detect(_context: AdapterContext): Promise<MediaCandidate[]> {
    return [];
  }

  rank(candidates: MediaCandidate[]): MediaCandidate[] {
    return candidates;
  }

  normalize(candidate: MediaCandidate): MediaCandidate {
    return candidate;
  }
}
