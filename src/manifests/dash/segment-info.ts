/**
 * Segment information (ISO/IEC 23009-1 5.3.9): how a representation's media is split into
 * fetchable pieces.
 *
 * SegmentTemplate, SegmentList and SegmentBase may sit on a Period, an AdaptationSet or a
 * Representation. A lower level overrides the level above it attribute by attribute, and an
 * element a lower level does not declare is inherited whole (5.3.9.1). So the parser calls
 * `inheritSegmentInfo` once per level on the way down, and `segmentAddressingFor` once per
 * Representation, which applies the defaults, validates, and returns one DashSegmentAddressing.
 *
 * Defaults are applied only after the merge. Filling them in while reading would make an explicit
 * child value that happens to equal a default (timescale="1") look like an absent one, and the
 * parent's value would wrongly win.
 */

import type { Segment } from '../segment-plan.ts';
import { resolveUrl } from '../url.ts';
import type { DashSegmentAddressing, DashTemplate, DashTimelineEntry } from './model.ts';
import { attr, attrBigInt, attrNum, childrenNamed, firstChildNamed, type XmlNode } from './xml.ts';

/** Defaults for absent attributes (5.3.9.2, 5.3.9.4). */
const DEFAULT_TIMESCALE = 1;
const DEFAULT_START_NUMBER = 1;
const DEFAULT_PRESENTATION_TIME_OFFSET = 0n;

/** In order of precedence, for the (invalid) case of more than one on the same level. */
const SEGMENT_ELEMENTS = ['SegmentTemplate', 'SegmentList', 'SegmentBase'] as const;
type SegmentElement = (typeof SEGMENT_ELEMENTS)[number];

const UNKNOWN: DashSegmentAddressing = { addressing: 'unknown' };

/** A URL as written (absent = the BaseURL) plus an optional byte range, e.g. "0-862". */
interface SourceRef {
  url?: string;
  range?: string;
}

/** One element's attributes exactly as written. Undefined = not set here, inherit from above. */
interface SegmentAttributes {
  timescale?: number;
  presentationTimeOffset?: bigint;
  /** @duration, in @timescale ticks. */
  duration?: number;
  startNumber?: number;
  /** SegmentTemplate@media and @initialization: URL templates. */
  media?: string;
  initialization?: string;
  /** The Initialization child of SegmentBase or SegmentList. */
  initializationRef?: SourceRef;
  timeline?: DashTimelineEntry[];
  /** SegmentList's SegmentURL children. */
  segmentUrls?: SourceRef[];
}

/** Segment information handed down the MPD hierarchy. */
export interface InheritedSegmentInfo {
  /** The element declared at the lowest level so far. It decides the addressing mode. */
  nearest?: SegmentElement;
  /** Each element's attributes, merged parent first with the child overriding. */
  merged: Partial<Record<SegmentElement, SegmentAttributes>>;
}

export const NO_SEGMENT_INFO: InheritedSegmentInfo = { merged: {} };

/** Merge the segment elements declared directly on `node` into what its parent handed down. */
export function inheritSegmentInfo(
  parent: InheritedSegmentInfo,
  node: XmlNode,
): InheritedSegmentInfo {
  const merged = { ...parent.merged };
  let nearest: SegmentElement | undefined;
  for (const name of SEGMENT_ELEMENTS) {
    const element = firstChildNamed(node, name);
    if (!element) continue;
    merged[name] = overlay(parent.merged[name], readAttributes(element));
    nearest ??= name;
  }
  return { nearest: nearest ?? parent.nearest, merged };
}

/**
 * Resolve a Representation's inherited segment information into one addressing mode.
 * `baseUrl` is the Representation's resolved BaseURL; `manifestUrl` is the MPD's own URL, which
 * is what the BaseURL falls back to when no BaseURL element exists anywhere (5.6).
 */
export function segmentAddressingFor(
  info: InheritedSegmentInfo,
  baseUrl: string,
  manifestUrl: string,
): DashSegmentAddressing {
  switch (info.nearest) {
    case 'SegmentTemplate':
      return templateAddressing(info.merged.SegmentTemplate ?? {});
    case 'SegmentList':
      return listAddressing(info.merged.SegmentList ?? {}, baseUrl);
    case 'SegmentBase':
      return singleFileAddressing(info.merged.SegmentBase ?? {}, baseUrl, manifestUrl);
    default:
      // No segment information at all: the BaseURL is the one and only segment (5.3.9.1).
      return singleFileAddressing({}, baseUrl, manifestUrl);
  }
}

function readAttributes(element: XmlNode): SegmentAttributes {
  const init = firstChildNamed(element, 'Initialization');
  const timeline = firstChildNamed(element, 'SegmentTimeline');
  const segmentUrls = childrenNamed(element, 'SegmentURL');
  return {
    timescale: attrNum(element, 'timescale'),
    presentationTimeOffset: attrBigInt(element, 'presentationTimeOffset'),
    duration: attrNum(element, 'duration'),
    startNumber: attrNum(element, 'startNumber'),
    media: attr(element, 'media'),
    initialization: attr(element, 'initialization'),
    initializationRef: init && { url: attr(init, 'sourceURL'), range: attr(init, 'range') },
    timeline: timeline && readTimeline(timeline),
    segmentUrls:
      segmentUrls.length > 0
        ? segmentUrls.map((url) => ({ url: attr(url, 'media'), range: attr(url, 'mediaRange') }))
        : undefined,
  };
}

/** Child attributes override the parent's one by one; child elements replace the parent's whole. */
function overlay(parent: SegmentAttributes = {}, child: SegmentAttributes): SegmentAttributes {
  return {
    timescale: child.timescale ?? parent.timescale,
    presentationTimeOffset: child.presentationTimeOffset ?? parent.presentationTimeOffset,
    duration: child.duration ?? parent.duration,
    startNumber: child.startNumber ?? parent.startNumber,
    media: child.media ?? parent.media,
    initialization: child.initialization ?? parent.initialization,
    initializationRef: child.initializationRef ?? parent.initializationRef,
    timeline: child.timeline ?? parent.timeline,
    segmentUrls: child.segmentUrls ?? parent.segmentUrls,
  };
}

/**
 * SegmentTimeline S elements (5.3.9.6). S@t and S@d are xs:unsignedLong, so they stay bigint.
 * An S without a positive @d describes no media - and with r="-1" it would repeat forever - so
 * it is dropped.
 */
function readTimeline(node: XmlNode): DashTimelineEntry[] {
  return childrenNamed(node, 'S').flatMap((s) => {
    const d = attrBigInt(s, 'd');
    if (d === undefined || d <= 0n) return [];
    const t = attrBigInt(s, 't');
    const r = Math.trunc(attrNum(s, 'r') ?? 0);
    return [t !== undefined ? { t, d, r } : { d, r }];
  });
}

function templateAddressing(attributes: SegmentAttributes): DashSegmentAddressing {
  const { media, initialization, timeline, duration } = attributes;
  const timescale = attributes.timescale ?? DEFAULT_TIMESCALE;
  // Without @media there are no segment URLs; a timescale <= 0 makes every duration meaningless.
  if (!media || !(timescale > 0)) return UNKNOWN;

  const template: DashTemplate = {
    media,
    ...(initialization ? { initialization } : {}),
    timescale,
    startNumber: attributes.startNumber ?? DEFAULT_START_NUMBER,
    presentationTimeOffset: attributes.presentationTimeOffset ?? DEFAULT_PRESENTATION_TIME_OFFSET,
  };
  // @duration and SegmentTimeline are mutually exclusive (5.3.9.2); if inheritance brings both,
  // the explicit timeline is the more precise of the two.
  if (timeline && timeline.length > 0) {
    return { addressing: 'template-timeline', template, timeline };
  }
  if (duration !== undefined && Number.isSafeInteger(duration) && duration > 0) {
    return { addressing: 'template-duration', template, segmentDuration: duration };
  }
  // Neither: the spec reads that as a single segment, but in practice it is a broken manifest,
  // and downloading one segment of it would silently produce a truncated file.
  return UNKNOWN;
}

/**
 * SegmentList (5.3.9.3). A SegmentURL without @media is a byte range of the BaseURL itself: the
 * "main" profile layout MP4Box writes, one file addressed by ranges.
 */
function listAddressing(attributes: SegmentAttributes, baseUrl: string): DashSegmentAddressing {
  const timescale = attributes.timescale ?? DEFAULT_TIMESCALE;
  const { duration } = attributes;
  // An unusable @duration or @timescale loses the per-segment length, not the segments.
  const seconds =
    timescale > 0 && duration !== undefined && duration > 0 ? duration / timescale : undefined;

  const segments = (attributes.segmentUrls ?? []).flatMap((ref) => {
    const segment = toSegment(ref, baseUrl);
    if (!segment) return [];
    return [seconds !== undefined ? { ...segment, duration: seconds } : segment];
  });
  if (segments.length === 0) return UNKNOWN;

  const init = attributes.initializationRef && toSegment(attributes.initializationRef, baseUrl);
  return { addressing: 'list', ...(init ? { init } : {}), segments };
}

/**
 * SegmentBase (5.3.9.2), or no segment information at all: the whole representation is the file
 * at the BaseURL. Initialization@range and @indexRange point inside that file, which is fetched
 * whole, so they add nothing.
 *
 * The exception is an Initialization@sourceURL naming a different resource: then the media file
 * has no ftyp/moov of its own, and the result is a one-segment list with a separate init.
 */
function singleFileAddressing(
  attributes: SegmentAttributes,
  baseUrl: string,
  manifestUrl: string,
): DashSegmentAddressing {
  if (!namesMediaFile(baseUrl, manifestUrl)) return UNKNOWN;
  const init = attributes.initializationRef && toSegment(attributes.initializationRef, baseUrl);
  if (init && init.url !== baseUrl) {
    return { addressing: 'list', init, segments: [{ url: baseUrl }] };
  }
  return { addressing: 'base' };
}

/**
 * A SegmentURL or Initialization element as a fetchable segment. An absent URL means the BaseURL,
 * and then the byte range is what picks the segment out of it (5.3.9.2, 5.3.9.3); with neither
 * there is nothing to fetch.
 */
function toSegment(ref: SourceRef, baseUrl: string): Segment | undefined {
  if (!ref.url && !ref.range) return undefined;
  const url = ref.url ? (resolveUrl(ref.url, baseUrl) ?? ref.url) : baseUrl;
  return ref.range ? { url, range: `bytes=${ref.range}` } : { url };
}

/**
 * With no BaseURL anywhere the resolved base is the MPD's own URL (5.6), and a base whose path
 * ends in "/" is a directory. Neither is a media file.
 */
function namesMediaFile(baseUrl: string, manifestUrl: string): boolean {
  if (baseUrl === manifestUrl) return false;
  try {
    return !new URL(baseUrl).pathname.endsWith('/');
  } catch {
    return false;
  }
}
