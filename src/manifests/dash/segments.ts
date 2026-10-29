/**
 * Compiles a parsed DASH representation into the engine's segment plan, at download time.
 *
 * One function per addressing mode (ISO/IEC 23009-1 5.3.9):
 *   template-timeline  SegmentTemplate + SegmentTimeline: each segment's start and length listed
 *   template-duration  SegmentTemplate + @duration: fixed-length segments, $Number$ counts up
 *   list               SegmentList: every URL or byte range listed (already resolved by the parser)
 *   base               one self-contained file at baseUrl, fetched once and whole
 *
 * Timeline arithmetic stays in bigint @timescale ticks. Live-to-VOD timelines are often anchored
 * at the Unix epoch, where S@t exceeds 2^53 and a number can no longer hold the exact value that
 * $Time$ has to print. Ticks become seconds (number) only at the edge, for the plan.
 */

import {
  assertPlanSize,
  MAX_PLAN_SEGMENTS,
  type Segment,
  type SegmentPlan,
} from '../segment-plan.ts';
import { resolveUrl } from '../url.ts';
import {
  type DashRepresentation,
  type DashRepresentationInfo,
  type DashTemplate,
  type DashTimelineEntry,
  type DurationAddressing,
  estimateBytes,
  type ListAddressing,
  type SingleFileAddressing,
  type TimelineAddressing,
} from './model.ts';

/**
 * Enumeration stops one past the plan cap: enough for `assertPlanSize` to
 * refuse the stream, without letting a malformed @duration or S@r generate
 * millions of URLs first.
 */
const ENUMERATION_LIMIT = MAX_PLAN_SEGMENTS + 1;

/** $Identifier$ or $Identifier%0<width>d$ (5.3.9.4.4, Table 16), or `$$` for a literal "$". */
const TEMPLATE_IDENTIFIER = /\$\$|\$([A-Za-z]+)(?:%0(\d+)d)?\$/g;

export interface BuildOptions {
  /** Period duration in seconds; needed for template+@duration and for S@r="-1". */
  periodDuration?: number;
  live?: boolean;
}

/** The parts of a plan each addressing mode produces; `toPlan` adds size and liveness. */
interface PlanParts {
  init?: Segment;
  segments: Segment[];
  /** Seconds. */
  totalDuration: number;
}

/** A timeline segment in @timescale ticks. */
interface TimedSegment {
  time: bigint;
  duration: bigint;
}

const NO_SEGMENTS: PlanParts = { segments: [], totalDuration: 0 };

export function buildSegmentPlan(rep: DashRepresentation, options: BuildOptions = {}): SegmentPlan {
  const periodSeconds = usablePeriodSeconds(options.periodDuration);
  const live = options.live === true;

  switch (rep.addressing) {
    case 'template-timeline':
      return toPlan(rep, fromTimeline(rep, periodSeconds), live);
    case 'template-duration':
      return toPlan(rep, fromDuration(rep, periodSeconds), live);
    case 'list':
      return toPlan(rep, fromList(rep, periodSeconds), live);
    case 'base':
      return toPlan(rep, fromSingleFile(rep, periodSeconds), live);
    case 'unknown':
      return { segments: [], totalDuration: 0, live };
  }
}

/**
 * How many media segments `buildSegmentPlan` lists for a representation, worked out without
 * building a single URL. The scan asks it of every representation in an MPD, to know which ones a
 * download would refuse (ARCHITECTURE.md D21: none, or more than one plan may hold); building each
 * plan to count it would expand thousands of templates per representation. Like the enumeration it
 * stands for, it stops one past the plan cap.
 */
export function countSegments(rep: DashRepresentation, options: BuildOptions = {}): number {
  const periodSeconds = usablePeriodSeconds(options.periodDuration);
  switch (rep.addressing) {
    case 'template-timeline':
      return countTimeline(rep.timeline, periodEndTick(rep.template, periodSeconds));
    case 'template-duration':
      return periodSeconds === undefined ? 0 : durationSegmentCount(rep, periodSeconds);
    case 'list':
      return Math.min(rep.segments.length, ENUMERATION_LIMIT);
    case 'base':
      return 1;
    case 'unknown':
      return 0;
  }
}

/** Guarded once: a zero, negative or NaN Period length means "unknown" everywhere below. */
function usablePeriodSeconds(periodDuration: number | undefined): number | undefined {
  return periodDuration !== undefined && periodDuration > 0 ? periodDuration : undefined;
}

function fromTimeline(
  rep: DashRepresentationInfo & TimelineAddressing,
  periodSeconds: number | undefined,
): PlanParts {
  const { template } = rep;
  const timed = expandTimeline(rep.timeline, periodEndTick(template, periodSeconds));
  const segments = timed.map(({ time, duration }, index) => ({
    // With a SegmentTimeline, $Number$ still counts segments from @startNumber (5.3.9.4.4).
    url: expandTemplate(template.media, rep, { number: template.startNumber + index, time }),
    duration: ticksToSeconds(duration, template.timescale),
  }));
  const totalTicks = timed.reduce((sum, segment) => sum + segment.duration, 0n);
  return {
    ...templateInit(rep, template),
    segments,
    totalDuration: ticksToSeconds(totalTicks, template.timescale),
  };
}

/**
 * Every segment a SegmentTimeline describes (5.3.9.6). An S without @t starts where the previous
 * segment ended. S@r repeats the segment r more times; a negative r repeats it until the next
 * S@t, or else the end of the Period.
 */
function expandTimeline(
  timeline: DashTimelineEntry[],
  periodEnd: bigint | undefined,
): TimedSegment[] {
  const out: TimedSegment[] = [];
  let nextStart = 0n;
  timeline.forEach((entry, index) => {
    let time = entry.t ?? nextStart;
    const count =
      entry.r >= 0 ? entry.r + 1 : repeatUntil(time, entry.d, timeline[index + 1]?.t ?? periodEnd);
    for (let i = 0; i < count && out.length < ENUMERATION_LIMIT; i += 1) {
      out.push({ time, duration: entry.d });
      time += entry.d;
    }
    nextStart = time;
  });
  return out;
}

/**
 * `expandTimeline`'s count, run for run: the same start rule and the same repeat rule, without
 * listing the segments. Past the cap the two part ways, but nothing past the cap is listed.
 */
function countTimeline(timeline: DashTimelineEntry[], periodEnd: bigint | undefined): number {
  let total = 0;
  let nextStart = 0n;
  for (const [index, entry] of timeline.entries()) {
    const time = entry.t ?? nextStart;
    const count =
      entry.r >= 0 ? entry.r + 1 : repeatUntil(time, entry.d, timeline[index + 1]?.t ?? periodEnd);
    total += count;
    if (total >= ENUMERATION_LIMIT) return ENUMERATION_LIMIT;
    nextStart = time + BigInt(count) * entry.d;
  }
  return total;
}

/** How many `duration`-long segments from `start` it takes to reach `end`; the last may overrun. */
function repeatUntil(start: bigint, duration: bigint, end: bigint | undefined): number {
  // No end known (a live Period with no following S@t): only the segment described exists yet.
  if (end === undefined || end <= start) return 1;
  return Number((end - start + duration - 1n) / duration);
}

/**
 * The end of the Period on the S@t axis. S@t minus @presentationTimeOffset is the time since the
 * Period started (5.3.9.6), so the Period ends at PTO + duration x timescale.
 */
function periodEndTick(
  template: DashTemplate,
  periodSeconds: number | undefined,
): bigint | undefined {
  if (periodSeconds === undefined) return undefined;
  return template.presentationTimeOffset + BigInt(Math.round(periodSeconds * template.timescale));
}

function fromDuration(
  rep: DashRepresentationInfo & DurationAddressing,
  periodSeconds: number | undefined,
): PlanParts {
  // Without a Period length there is nothing to count (a live MPD); the caller reports it.
  if (periodSeconds === undefined) return NO_SEGMENTS;

  const { template, segmentDuration } = rep;
  const count = durationSegmentCount(rep, periodSeconds);
  const seconds = segmentDuration / template.timescale;

  const segments = Array.from({ length: count }, (_, index) => ({
    url: expandTemplate(template.media, rep, {
      number: template.startNumber + index,
      // $Time$ belongs with a SegmentTimeline; here it is the segment's start on the same axis.
      time: template.presentationTimeOffset + BigInt(index) * BigInt(segmentDuration),
    }),
    duration: seconds,
  }));
  return { ...templateInit(rep, template), segments, totalDuration: count * seconds };
}

/**
 * Every segment is @duration long except possibly the last, which may be shorter (5.3.9.2), so the
 * count rounds up. Counting in whole ticks keeps 6.006 s / 2.002 s at exactly 3.
 */
function durationSegmentCount(
  rep: DashRepresentationInfo & DurationAddressing,
  periodSeconds: number,
): number {
  const periodTicks = Math.round(periodSeconds * rep.template.timescale);
  return Math.min(ENUMERATION_LIMIT, Math.ceil(periodTicks / rep.segmentDuration));
}

function fromList(
  rep: DashRepresentationInfo & ListAddressing,
  periodSeconds: number | undefined,
): PlanParts {
  const segments = rep.segments.slice(0, ENUMERATION_LIMIT);
  const listed = segments.every((segment) => segment.duration !== undefined)
    ? segments.reduce((sum, segment) => sum + (segment.duration ?? 0), 0)
    : undefined;
  return {
    ...(rep.init ? { init: rep.init } : {}),
    segments,
    totalDuration: listed ?? periodSeconds ?? 0,
  };
}

/**
 * The whole file in one request. There is deliberately no init segment: SegmentBase's
 * Initialization@range lies inside this same file, so fetching it separately would write
 * ftyp/moov twice.
 */
function fromSingleFile(
  rep: DashRepresentationInfo & SingleFileAddressing,
  periodSeconds: number | undefined,
): PlanParts {
  const segment: Segment =
    periodSeconds !== undefined
      ? { url: rep.baseUrl, duration: periodSeconds }
      : { url: rep.baseUrl };
  return { segments: [segment], totalDuration: periodSeconds ?? 0 };
}

/** SegmentTemplate@initialization may not use $Number$ or $Time$ (5.3.9.4), so their values are moot. */
function templateInit(rep: DashRepresentationInfo, template: DashTemplate): { init?: Segment } {
  if (!template.initialization) return {};
  const values = { number: template.startNumber, time: 0n };
  return { init: { url: expandTemplate(template.initialization, rep, values) } };
}

function toPlan(rep: DashRepresentationInfo, parts: PlanParts, live: boolean): SegmentPlan {
  assertPlanSize(parts.segments.length);
  const bytes = estimateBytes(rep.bandwidth, parts.totalDuration) ?? rep.sizeBytes;
  return {
    ...(parts.init ? { init: parts.init } : {}),
    segments: parts.segments,
    totalDuration: parts.totalDuration,
    ...(bytes !== undefined ? { estimatedBytes: bytes } : {}),
    live,
  };
}

function ticksToSeconds(ticks: bigint, timescale: number): number {
  return Number(ticks) / timescale;
}

/**
 * Expand the identifiers of a SegmentTemplate URL (5.3.9.4.4, Table 16) and resolve the result
 * against the representation's BaseURL:
 *   $RepresentationID$  Representation@id
 *   $Number$            segment number, counting from @startNumber
 *   $Time$              segment start in @timescale ticks, exactly as S@t writes it (PTO included)
 *   $Bandwidth$         Representation@bandwidth
 *   $$                  a literal "$"
 * $Number$, $Time$ and $Bandwidth$ may carry a printf-style width: `$Number%05d$` with 42 gives
 * `00042`. An unknown identifier is left as written, so the bad URL fails loudly at fetch time.
 */
export function expandTemplate(
  template: string,
  rep: Pick<DashRepresentationInfo, 'id' | 'bandwidth' | 'baseUrl'>,
  values: { number: number; time: number | bigint },
): string {
  const expanded = template.replace(TEMPLATE_IDENTIFIER, (whole, name?: string, width?: string) => {
    if (whole === '$$') return '$';
    const pad = width ? Number(width) : 0;
    switch (name) {
      case 'RepresentationID':
        return rep.id;
      case 'Number':
        return format(values.number, pad);
      case 'Time':
        return format(values.time, pad);
      case 'Bandwidth':
        return format(rep.bandwidth ?? 0, pad);
      default:
        return whole;
    }
  });
  return resolveUrl(expanded, rep.baseUrl) ?? expanded;
}

function format(value: number | bigint, width: number): string {
  const text = typeof value === 'bigint' ? value.toString() : String(Math.trunc(value));
  return text.padStart(width, '0');
}
