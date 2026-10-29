/**
 * Reading a saveability (ARCHITECTURE.md D21): can this candidate, or this
 * rendition of it, be saved?
 *
 * Separate from detection/saveability.ts, which decides it, because this half
 * runs in the popup: it needs only the candidate, and media/ depends on core/
 * alone, so the UI never pulls in the scan's manifest facts or download caps.
 *
 * The scan decides it (detection/saveability.ts); everything that offers a
 * download - "Best download", a row's buttons, the ladder - asks here, so they
 * cannot disagree. Two things are read from the candidate itself rather than
 * trusted to the field, because a scan stored by an older build carries no
 * field at all: DRM, and a `blob:` URL.
 */
import type { MediaCandidate, MediaVariant, Saveability } from '../core/types.ts';

/** Undefined only when nothing was decided (a manifest the scan did not read), which is not a "no". */
export function saveabilityOf(candidate: MediaCandidate): Saveability | undefined {
  return inherentRefusal(candidate) ?? candidate.saveability;
}

/**
 * The "no" a candidate carries on its face, whatever any scan decided: a DRM
 * system, or a `blob:` URL that only the page's player can read. The scan
 * (detection/saveability.ts) starts from this too, so the two never differ
 * on either.
 */
export function inherentRefusal(candidate: MediaCandidate): Saveability | undefined {
  if (candidate.drm === true) return 'drm';
  if (candidate.protocol === 'blob') return 'media-source';
  return undefined;
}

/** A rendition inherits its candidate's "no"; otherwise it answers for itself. */
export function renditionSaveability(
  candidate: MediaCandidate,
  variant: MediaVariant,
): Saveability | undefined {
  const whole = saveabilityOf(candidate);
  return isSaveable(whole) ? (variant.saveability ?? whole) : whole;
}

/** Nothing decided counts as saveable: the download itself is the last word. */
export function isSaveable(status: Saveability | undefined): boolean {
  return status === undefined || status === 'saveable';
}
