/**
 * The detection pipeline (PRD s71): everything known about a tab in, a ranked
 * list and a diagnosis out.
 *
 *   DOM + page hook ─┐
 *   network ─────────┼─> collect ─> adapter.detect ─> dedupe ─> adapter.normalize
 *                    │                                               │
 *                    │          expand the best manifests (cached) <─┘
 *                    │                        │
 *                    │    probe each HLS master's best rendition (cached)
 *                    │                        │
 *                    │    decide what can be saved (saveability.ts, D21)
 *                    │                        │
 *                    │    fold playlists a master already lists into it
 *                    │                        │
 *                    └──── posters ─> rank ─> adapter.rank ─> threshold ─> diagnose
 *
 * Why this order:
 *  - dedupe before normalize: one resource found twice keeps the best-sourced
 *    copy's own fields (a <video>'s title) instead of whatever an adapter
 *    filled in on the other copy.
 *  - dedupe before expansion: copies of one manifest cost one fetch, not one each.
 *  - probe after expansion: only the ladder says which rendition is best, and
 *    only that rendition's media playlist says whether the stream is
 *    encrypted, live, or too long - a master says none of it.
 *  - decide before fold: every expanded playlist is judged by what its own
 *    manifest said, including an audio playlist that becomes an audio row.
 *  - fold after expansion: a page that plays HLS shows its master AND every
 *    rendition, audio and subtitle playlist the player fetched; once the
 *    master is expanded, renditions are rows inside it (a subtitle playlist on
 *    its own was offered as a 70-second "video") and audio playlists become
 *    audio rows.
 *
 * The generic path always runs. A site adapter can only ADD candidates and
 * RE-RANK them, so a broken adapter degrades detection instead of removing it.
 */
import { adapterFor } from '../adapters/registry.ts';
import type { SiteAdapter } from '../adapters/types.ts';
import { toMediaGrabError } from '../core/errors.ts';
import { MAX_MANIFEST_EXPANSIONS } from '../core/limits.ts';
import { createLogger } from '../core/log.ts';
import type {
  MediaCandidate,
  MediaVariant,
  PageSignals,
  Protocol,
  RejectedCandidate,
  ScanResult,
  ScanStats,
} from '../core/types.ts';
import { dedupe } from '../media/dedupe.ts';
import { normalizeUrl } from '../media/fingerprint.ts';
import { backfillPosters } from '../media/poster.ts';
import { bestVariantOf } from '../media/quality.ts';
import { DISPLAY_THRESHOLD, rank } from '../media/score.ts';
import { diagnose } from './diagnose.ts';
import { uncachedLoader } from './manifest-cache.ts';
import {
  type HlsMediaFacts,
  type ManifestDetails,
  type StreamFacts,
  withManifestDetails,
} from './manifest-loader.ts';
import { assessSaveability } from './saveability.ts';

const log = createLogger('engine');

export interface ScanInput {
  tabId: number;
  pageUrl: string;
  pageTitle: string;
  /** From the tab's content scripts: DOM, page hook, Resource Timing. */
  pageCandidates: MediaCandidate[];
  /** From the worker's network observer. */
  networkCandidates: MediaCandidate[];
  signals: PageSignals;
  requestsObserved: number;
  /** og:image / twitter:image / a player's poster, for candidates with no picture. */
  pagePoster?: string;
  /** Where manifest details come from. The scanner passes its cache; tests pass fakes. */
  manifests?: ManifestSource;
}

type ManifestSource = { details(candidate: MediaCandidate): Promise<ManifestDetails> };

/** Candidates after the manifest stages, with what each manifest said. */
interface Expanded {
  candidates: MediaCandidate[];
  /** By candidate id; only for candidates whose manifest was read this scan. */
  facts: Map<string, StreamFacts>;
  /** Manifests read this scan, rendition playlists included. */
  count: number;
}

/** Anything the pipeline had to leave out, and why - for debug mode and the stats line. */
interface Losses {
  rejected: RejectedCandidate[];
  errors: number;
}

export async function runScan(input: ScanInput): Promise<ScanResult> {
  const losses: Losses = { rejected: [], errors: 0 };
  const adapter = adapterFor(input.pageUrl);

  const collected = [...input.pageCandidates, ...input.networkCandidates].map((candidate) => ({
    ...candidate,
    pageUrl: candidate.pageUrl || input.pageUrl,
    pageTitle: candidate.pageTitle || input.pageTitle,
  }));
  const found = [...collected, ...(await adapterExtras(adapter, collected, input, losses))];
  const deduped = dedupe(found);
  const normalized = deduped.map((candidate) =>
    safely(() => adapter.normalize(candidate), candidate),
  );
  const manifests = input.manifests ?? { details: uncachedLoader() };
  const expanded = await probeBestRenditions(
    await expandManifests(normalized, manifests, losses),
    manifests,
    losses,
  );
  const assessed = expanded.candidates.map((candidate) =>
    assessSaveability(candidate, expanded.facts.get(candidate.id)),
  );
  const withPosters = backfillPosters(foldNestedPlaylists(assessed), {
    ...(input.pagePoster ? { pagePoster: input.pagePoster } : {}),
  });

  const scored = rank(withPosters);
  let ranked = scored;
  try {
    ranked = adapter.rank(scored);
  } catch (err) {
    losses.errors += 1;
    log.warn(`adapter ${adapter.id} rank() failed`, toMediaGrabError(err).message);
  }

  const visible: MediaCandidate[] = [];
  for (const candidate of ranked) {
    if ((candidate.score ?? 0) >= DISPLAY_THRESHOLD) visible.push(candidate);
    else
      losses.rejected.push({
        url: candidate.url,
        reason: `score ${candidate.score} below display threshold`,
      });
  }

  const stats: ScanStats = {
    networkRequestsObserved: input.requestsObserved,
    mediaElements: input.signals.mediaElements,
    candidatesRaw: found.length,
    candidatesAfterDedupe: deduped.length,
    manifestsParsed: expanded.count,
    byProtocol: countByProtocol(ranked),
    parseErrors: losses.errors,
  };
  const diagnosis = diagnose(visible, stats, input.signals);

  return {
    tabId: input.tabId,
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    scannedAt: Date.now(),
    candidates: visible,
    rejected: losses.rejected,
    stats,
    ...(diagnosis ? { diagnosis } : {}),
  };
}

async function adapterExtras(
  adapter: SiteAdapter,
  candidates: MediaCandidate[],
  input: ScanInput,
  losses: Losses,
): Promise<MediaCandidate[]> {
  try {
    const extra = await adapter.detect({
      pageUrl: input.pageUrl,
      pageTitle: input.pageTitle,
      candidates,
    });
    if (extra.length > 0) log.debug(`adapter ${adapter.id} added ${extra.length} candidates`);
    return extra;
  } catch (err) {
    // An adapter failure must never break generic detection.
    losses.errors += 1;
    log.warn(`adapter ${adapter.id} failed`, toMediaGrabError(err).message);
    return [];
  }
}

/** Expand the most promising manifests, best-ranked first, within the per-scan budget. */
async function expandManifests(
  candidates: MediaCandidate[],
  manifests: ManifestSource,
  losses: Losses,
): Promise<Expanded> {
  const chosen = rank(candidates)
    .filter((candidate) => candidate.protocol === 'hls' || candidate.protocol === 'dash')
    .filter((candidate) => (candidate.variants?.length ?? 0) === 0)
    .slice(0, MAX_MANIFEST_EXPANSIONS);

  const expandedById = new Map<string, MediaCandidate>();
  const facts = new Map<string, StreamFacts>();
  await Promise.all(
    chosen.map(async (candidate) => {
      try {
        const details = await manifests.details(candidate);
        expandedById.set(candidate.id, withManifestDetails(candidate, details));
        if (details.facts) facts.set(candidate.id, details.facts);
      } catch (err) {
        const error = toMediaGrabError(err);
        losses.errors += 1;
        losses.rejected.push({ url: candidate.url, reason: `${error.code}: ${error.message}` });
        log.debug('manifest expansion failed', { url: candidate.url, code: error.code });
      }
    }),
  );

  return {
    candidates: candidates.map((candidate) => expandedById.get(candidate.id) ?? candidate),
    facts,
    count: expandedById.size,
  };
}

/**
 * An HLS master says nothing about its segments: whether they are encrypted,
 * whether the stream has ended, how long it is. Its best rendition's media
 * playlist does, and speaks for the whole ladder - renditions of one master
 * share keys and timeline. So each master expanded this scan gets one more
 * fetch, of that one playlist, through the same cache as the masters: a burst
 * of scans fetches it once, and there are never more probes than expansions.
 *
 * A probe that fails leaves the master as it was - offered, undecided - and
 * the download finds out, as before.
 */
async function probeBestRenditions(
  expanded: Expanded,
  manifests: ManifestSource,
  losses: Losses,
): Promise<Expanded> {
  const facts = new Map(expanded.facts);
  let count = expanded.count;
  const candidates = await Promise.all(
    expanded.candidates.map(async (candidate) => {
      if (facts.get(candidate.id)?.document !== 'hls-master' || candidate.drm === true) {
        return candidate;
      }
      const best = bestVariantOf(candidate);
      if (!best) return candidate;
      try {
        const details = await manifests.details({
          ...candidate,
          url: best.url,
          protocol: 'hls',
          variants: [],
        });
        if (details.facts?.document !== 'hls-media') return candidate;
        count += 1;
        facts.set(candidate.id, details.facts);
        return withBestRendition(candidate, best, details, details.facts);
      } catch (err) {
        const error = toMediaGrabError(err);
        losses.errors += 1;
        log.debug('rendition probe failed', { url: best.url, code: error.code });
        return candidate;
      }
    }),
  );
  return { candidates, facts, count };
}

/**
 * A master, with what its best rendition's playlist said: the stream's length,
 * whether it has ended and whether a DRM system guards it - true of every
 * rendition - and that rendition's own container and segment count.
 */
function withBestRendition(
  master: MediaCandidate,
  probed: MediaVariant,
  details: ManifestDetails,
  facts: HlsMediaFacts,
): MediaCandidate {
  return {
    ...master,
    ...(master.duration === undefined && details.duration !== undefined
      ? { duration: details.duration }
      : {}),
    ...(details.live === true ? { live: true } : {}),
    ...(details.drm === true
      ? { drm: true, ...(details.drmSystem ? { drmSystem: details.drmSystem } : {}) }
      : {}),
    variants: (master.variants ?? []).map((variant) =>
      variant.id === probed.id
        ? { ...variant, format: facts.container, segmentCount: facts.segmentCount }
        : variant,
    ),
  };
}

/**
 * Fold what an expanded master already lists into it.
 *
 *  - a rendition or subtitle playlist: dropped - the master's own row offers
 *    the rendition, and a subtitle playlist on its own is not a video
 *  - an audio track: kept, as an audio row. Nothing can join it to a
 *    video-only rendition yet (no muxer), so its own row is the only way to
 *    download the sound; it is relabelled, since on its own an HLS playlist
 *    looks like a video.
 */
function foldNestedPlaylists(candidates: MediaCandidate[]): MediaCandidate[] {
  const listed = new Set<string>();
  const audio = new Map<string, MediaVariant>();
  for (const master of candidates) {
    for (const nested of [...(master.variants ?? []), ...(master.subtitles ?? [])]) {
      if (nested.url !== master.url) listed.add(normalizeUrl(nested.url));
    }
    for (const track of master.audioTracks ?? []) {
      if (track.url !== master.url) audio.set(normalizeUrl(track.url), track);
    }
  }
  if (listed.size === 0 && audio.size === 0) return candidates;

  const folded: MediaCandidate[] = [];
  for (const candidate of candidates) {
    const key = normalizeUrl(candidate.url);
    const isMaster = (candidate.variants?.length ?? 0) > 0;
    const track = audio.get(key);
    if (!isMaster && track) {
      folded.push({
        ...candidate,
        kind: 'audio',
        tracks: { video: false, audio: true },
        ...(track.label ? { label: track.label } : {}),
        ...(track.language ? { language: track.language } : {}),
      });
    } else if (isMaster || !listed.has(key)) {
      folded.push(candidate);
    }
  }
  return folded;
}

function safely<T>(work: () => T, fallback: T): T {
  try {
    return work();
  } catch {
    return fallback;
  }
}

function countByProtocol(candidates: MediaCandidate[]): Record<Protocol, number> {
  const counts: Record<Protocol, number> = {
    progressive: 0,
    hls: 0,
    dash: 0,
    blob: 0,
    data: 0,
    unknown: 0,
  };
  for (const candidate of candidates) counts[candidate.protocol] += 1;
  return counts;
}
