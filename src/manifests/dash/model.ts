/**
 * The parsed DASH model, shared by the MPD parser (parse.ts, segment-info.ts) and the plan
 * builder (segments.ts), plus the size estimate both sides need.
 *
 * How a representation's bytes are addressed is a discriminated union on `addressing`. Each mode
 * carries exactly the data it needs, so a representation cannot hold a template, a list and a
 * base at once, and `addressing` cannot disagree with the data next to it.
 */
import type { Segment } from '../segment-plan.ts';

const BITS_PER_BYTE = 8;

export interface DashManifest {
  /** MPD@type. "dynamic" is live: the MPD keeps changing and may never end (ISO/IEC 23009-1 5.3.1.2). */
  type: 'static' | 'dynamic';
  live: boolean;
  /** MPD@mediaPresentationDuration, seconds. */
  duration?: number;
  periods: DashPeriod[];
  /** True when a ContentProtection descriptor appears anywhere in the MPD. */
  drm: boolean;
  drmSystems: string[];
}

export interface DashPeriod {
  /** Period@id, or `p<index>` when absent. Stable across refreshes of a live MPD (5.3.2.2). */
  id: string;
  /** Seconds from the start of the presentation (5.3.2.1). */
  start: number;
  /** Seconds; undefined when neither the Period nor the MPD says. Always > 0 when set. */
  duration?: number;
  representations: DashRepresentation[];
}

export type DashContentType = 'video' | 'audio' | 'text' | 'image' | 'unknown';

/** What a representation is, independent of how its bytes are addressed. */
export interface DashRepresentationInfo {
  id: string;
  adaptationSetId: string;
  contentType: DashContentType;
  mimeType?: string;
  codecs?: string[];
  /** Bits per second. */
  bandwidth?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  /** AudioChannelConfiguration@value. Kept for media/score.ts, which rewards surround audio. */
  audioChannels?: number;
  language?: string;
  label?: string;
  role?: string;
  /**
   * The fully-resolved BaseURL (5.6). When `addressing` is 'base' this is the media file itself;
   * otherwise it is what segment URLs resolve against.
   */
  baseUrl: string;
  /** Estimated bytes for the whole representation: bandwidth x Period duration. */
  sizeBytes?: number;
}

/** SegmentTemplate attributes after inheritance and defaults (5.3.9.4). */
export interface DashTemplate {
  /** URL template for media segments, e.g. `$RepresentationID$/$Number%05d$.m4s`. */
  media: string;
  /** URL template for the initialization segment. */
  initialization?: string;
  /** Ticks per second. Always > 0. */
  timescale: number;
  startNumber: number;
  /** In ticks, on the same axis as S@t. */
  presentationTimeOffset: bigint;
}

/** One SegmentTimeline S element (5.3.9.6), in @timescale ticks. */
export interface DashTimelineEntry {
  /** S@t; undefined means "starts where the previous segment ended". */
  t?: bigint;
  /** S@d. Always > 0: the parser drops entries without a usable duration. */
  d: bigint;
  /** S@r: how many more times the segment repeats. Negative means "until the next S@t or the Period end". */
  r: number;
}

/** SegmentTemplate + SegmentTimeline: every segment's start and length is listed (5.3.9.6). */
export interface TimelineAddressing {
  addressing: 'template-timeline';
  template: DashTemplate;
  timeline: DashTimelineEntry[];
}

/** SegmentTemplate + @duration: fixed-length segments numbered up from @startNumber. */
export interface DurationAddressing {
  addressing: 'template-duration';
  template: DashTemplate;
  /** @duration in @timescale ticks. Always a positive integer. */
  segmentDuration: number;
}

/** SegmentList: every segment is listed (5.3.9.3). URLs are absolute; ranges are Range headers. */
export interface ListAddressing {
  addressing: 'list';
  init?: Segment;
  segments: Segment[];
}

/**
 * The whole representation is one self-contained file at `baseUrl`: SegmentBase, or a BaseURL
 * with no segment information at all (5.3.9.1, 5.3.9.2). Its initialization data (ftyp/moov) is
 * inside the file, so it is fetched once, whole - a plain browser download is enough.
 */
export interface SingleFileAddressing {
  addressing: 'base';
}

/** Nothing MediaGrab can enumerate: no @media, no durations, invalid values, or no media URL. */
export interface UnknownAddressing {
  addressing: 'unknown';
}

export type DashSegmentAddressing =
  | TimelineAddressing
  | DurationAddressing
  | ListAddressing
  | SingleFileAddressing
  | UnknownAddressing;

export type DashRepresentation = DashRepresentationInfo & DashSegmentAddressing;

/** Bytes for `seconds` of media at `bandwidth` bits per second; undefined when either is unusable. */
export function estimateBytes(
  bandwidth: number | undefined,
  seconds: number | undefined,
): number | undefined {
  if (bandwidth === undefined || seconds === undefined || !(bandwidth > 0) || !(seconds > 0)) {
    return undefined;
  }
  return Math.round((bandwidth / BITS_PER_BYTE) * seconds);
}
