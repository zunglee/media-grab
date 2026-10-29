/**
 * Deciding, during the scan, whether each candidate and each rendition can be
 * saved (ARCHITECTURE.md D21), so a row listed as saveable does not fail on
 * click for a reason that was knowable before it.
 *
 * Separate from media/saveability.ts, which reads the answer in the popup,
 * because deciding needs the manifest's facts and the download's caps, and the
 * popup has no business importing either.
 *
 *   the candidate as a whole   DRM, a blob: URL, live, encrypted, several
 *                              Periods, trick-play only, too many segments,
 *                              a manifest with nothing in it
 *   then each rendition        too large to assemble, or no segments to fetch
 *   then the candidate again   nothing left that "best" could pick: the
 *                              first one's reason is the row's
 *
 * Every "no" here mirrors a refusal the download would make later (the
 * manager's DRM check; plan-builder.ts for live, encrypted, several Periods
 * and a rendition with no segments; segment-plan.ts `assertPlanSize`;
 * segment-fetcher.ts's assembly ceiling). The caps are shared constants
 * (core/limits.ts, segment-plan.ts), never copied, so the scan and the
 * download cannot drift.
 *
 * What is not known is not guessed: a manifest the scan did not read (over the
 * per-scan budget, or its fetch failed) keeps no status, and is offered as
 * before; the download stays the last word.
 */
import { MAX_ASSEMBLY_BYTES } from '../core/limits.ts';
import type { MediaCandidate, MediaVariant, Saveability } from '../core/types.ts';
import { MAX_PLAN_SEGMENTS } from '../manifests/segment-plan.ts';
import { downloadPool, estimatedBytes } from '../media/quality.ts';
import { inherentRefusal } from '../media/saveability.ts';
import type { StreamFacts } from './manifest-loader.ts';

/**
 * The candidate, with its saveability and that of every rendition that
 * differs from it. `facts` are what its manifest said this scan; absent for a
 * direct file, and for a manifest that was not read.
 */
export function assessSaveability(
  candidate: MediaCandidate,
  facts: StreamFacts | undefined,
): MediaCandidate {
  const whole = wholeStatus(candidate, facts);
  if (whole === undefined) return candidate;
  if (whole !== 'saveable') return { ...candidate, saveability: whole };

  const variants = candidate.variants?.map((variant) => judged(variant, candidate.duration));
  const audioTracks = candidate.audioTracks?.map((track) => judged(track, candidate.duration));
  // Only the renditions "best" draws from decide the row - the very pool it
  // draws from (media/quality.ts `downloadPool`), so the two cannot disagree.
  // A video ladder that is all too large leaves nothing to watch, even if an
  // audio-only variant in the same master would fit: "best" never picks it,
  // and a row called saveable would fail on click.
  const refused = downloadPool(variants ?? []).map((variant) => variant.saveability);
  const noneLeft = refused.length > 0 && refused.every((status) => status !== undefined);
  return {
    ...candidate,
    ...(variants ? { variants } : {}),
    ...(audioTracks ? { audioTracks } : {}),
    saveability: (noneLeft && refused[0]) || 'saveable',
  };
}

/** A reason that holds for every rendition at once; undefined when there is nothing to go on. */
function wholeStatus(
  candidate: MediaCandidate,
  facts: StreamFacts | undefined,
): Saveability | undefined {
  // DRM and a blob: URL, read exactly as the popup reads them.
  const inherent = inherentRefusal(candidate);
  if (inherent) return inherent;
  if (candidate.live === true) return 'live';
  // A direct file is the browser's to download: no segments, no assembly.
  if (candidate.protocol === 'progressive') return 'saveable';
  if (!facts) return undefined;

  switch (facts.document) {
    case 'hls-media': {
      // For a master these are its best rendition's (detection/engine.ts), and
      // they hold for the ladder: renditions of one master share their keys
      // and their timeline, since players switch between them segment by
      // segment.
      if (facts.encrypted) return 'encrypted';
      if (facts.segmentCount > MAX_PLAN_SEGMENTS) return 'too-large';
      // A playlist on its own is its own only rendition, and needs segments
      // someone can watch to be one.
      const alone = (candidate.variants?.length ?? 0) === 0;
      if (alone && (facts.iframesOnly || facts.segmentCount === 0)) return 'no-rendition';
      return 'saveable';
    }
    case 'dash':
      if (facts.periods > 1) return 'multi-period';
      return (candidate.variants?.length ?? 0) > 0 ? 'saveable' : 'no-rendition';
    case 'hls-master':
      return (candidate.variants?.length ?? 0) > 0 ? 'saveable' : 'no-rendition';
  }
}

/** The rendition, marked only when it cannot be saved. */
function judged(variant: MediaVariant, duration: number | undefined): MediaVariant {
  const status = renditionStatus(variant, duration);
  return status === 'saveable' ? variant : { ...variant, saveability: status };
}

function renditionStatus(variant: MediaVariant, duration: number | undefined): Saveability {
  // A single-file DASH representation downloads as a plain file: no plan, no assembly.
  if (variant.protocol === 'progressive') return 'saveable';
  if (variant.segmentCount !== undefined) {
    // plan-builder.ts refuses a rendition it cannot list a segment of.
    if (variant.segmentCount === 0) return 'no-rendition';
    if (variant.segmentCount > MAX_PLAN_SEGMENTS) return 'too-large';
  }
  const bytes = estimatedBytes(variant, duration);
  return bytes !== undefined && bytes > MAX_ASSEMBLY_BYTES ? 'too-large' : 'saveable';
}
