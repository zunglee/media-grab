/**
 * DASH MPD parser (ISO/IEC 23009-1), restricted to what a downloader needs: which
 * representations exist, what they carry, how big they are, whether the presentation is
 * protected, and how each one's segments are addressed.
 *
 * Flow: parseXml -> readPeriods -> readAdaptationSet -> readRepresentation. An MPD states most
 * things once, high up, and lets lower levels override them, so each level derives an `Inherited`
 * context from its parent (`descend`: BaseURL, segment information, common attributes) and hands
 * it down. Segment information is resolved in segment-info.ts.
 *
 * Pure: takes the manifest text plus its URL, returns data. No network. Anything that is not a
 * usable MPD throws MediaGrabError(UNSUPPORTED_MANIFEST).
 */

import { ErrorCode, MediaGrabError } from '../../core/errors.ts';
import { drmSystemNamed } from '../drm-systems.ts';
import { resolveUrl } from '../url.ts';
import { parseFrameRate, parseIsoDuration } from './duration.ts';
import {
  type DashContentType,
  type DashManifest,
  type DashPeriod,
  type DashRepresentation,
  estimateBytes,
} from './model.ts';
import {
  type InheritedSegmentInfo,
  inheritSegmentInfo,
  NO_SEGMENT_INFO,
  segmentAddressingFor,
} from './segment-info.ts';
import { attr, attrNum, childrenNamed, firstChildNamed, parseXml, type XmlNode } from './xml.ts';

export type { DashManifest } from './model.ts';

/** The Period MediaGrab offers. Only the first is: see `downloadablePeriod`. */
export function firstPeriod(manifest: DashManifest): DashPeriod {
  const period = manifest.periods[0];
  if (!period) throw new MediaGrabError(ErrorCode.UNSUPPORTED_MANIFEST, 'MPD contains no periods');
  return period;
}

/**
 * The Period a download covers. A multi-Period MPD is usually adverts spliced
 * into a programme; downloading only the first Period would save the advert
 * and silently drop the rest, so it is refused instead (like a stream too long
 * to assemble: never cut short).
 */
export function downloadablePeriod(manifest: DashManifest): DashPeriod {
  if (manifest.periods.length > 1) {
    throw new MediaGrabError(
      ErrorCode.UNSUPPORTED_MANIFEST,
      `This stream is made of ${manifest.periods.length} separate parts (often adverts), which MediaGrab cannot join into one file.`,
    );
  }
  return firstPeriod(manifest);
}

/** What a representation's segments join into (ISO BMFF unless it says WebM). */
export function dashContainer(rep: { mimeType?: string }): 'webm' | 'mp4' {
  return rep.mimeType?.toLowerCase().includes('webm') ? 'webm' : 'mp4';
}

/**
 * Common attributes and elements (5.3.7): set on an AdaptationSet, they apply to every
 * Representation in it unless the Representation sets its own.
 */
interface CommonAttributes {
  mimeType?: string;
  codecs?: string;
  frameRate?: string;
  width?: number;
  height?: number;
  audioChannels?: number;
}

/** What each level of the MPD hands down to the level below it. */
interface Inherited {
  /** The MPD's own URL: what BaseURL resolution starts from (5.6). */
  manifestUrl: string;
  /** The BaseURL resolved so far. */
  baseUrl: string;
  /** Seconds; set by the Period, used for size estimates. */
  periodDuration?: number;
  segmentInfo: InheritedSegmentInfo;
  common: CommonAttributes;
}

/** AdaptationSet facts that every Representation in it shares. */
interface AdaptationSetInfo {
  id: string;
  /** AdaptationSet@contentType; 'unknown' when absent (then the mimeType decides). */
  contentType: DashContentType;
  language?: string;
  label?: string;
  role?: string;
}

interface PeriodTiming {
  start: number;
  duration?: number;
}

export function looksLikeDash(text: string): boolean {
  return /<\s*MPD[\s>]/.test(text) || /urn:mpeg:dash:schema:mpd/.test(text);
}

export function parseDashManifest(text: string, manifestUrl: string): DashManifest {
  const mpd = parseXml(text);
  if (mpd.localName !== 'MPD') {
    throw new MediaGrabError(
      ErrorCode.UNSUPPORTED_MANIFEST,
      `Not an MPD document: the root element is <${mpd.name}>.`,
    );
  }

  // "dynamic" is a live presentation; "static", the default, is on demand (5.3.1.2).
  const type = attr(mpd, 'type') === 'dynamic' ? 'dynamic' : 'static';
  const duration = positive(parseIsoDuration(attr(mpd, 'mediaPresentationDuration')));
  const top: Inherited = {
    manifestUrl,
    baseUrl: resolveBaseUrl(manifestUrl, mpd),
    segmentInfo: NO_SEGMENT_INFO,
    common: {},
  };
  const drmSystems = collectDrmSystems(mpd);

  return {
    type,
    live: type === 'dynamic',
    ...(duration !== undefined ? { duration } : {}),
    periods: readPeriods(mpd, top, duration),
    drm: drmSystems.length > 0,
    drmSystems,
  };
}

function readPeriods(
  mpd: XmlNode,
  parent: Inherited,
  presentationDuration: number | undefined,
): DashPeriod[] {
  const nodes = childrenNamed(mpd, 'Period');
  const periods: DashPeriod[] = [];
  let previousEnd: number | undefined = 0;
  nodes.forEach((node, index) => {
    const next = nodes[index + 1];
    const end = next ? parseIsoDuration(attr(next, 'start')) : presentationDuration;
    const timing = periodTiming(node, previousEnd, end);
    periods.push(readPeriod(node, index, timing, parent));
    previousEnd = timing.duration !== undefined ? timing.start + timing.duration : undefined;
  });
  return periods;
}

/**
 * Period start and duration (5.3.2.1). It starts at its @start, else where the previous Period
 * ended (0 for the first one, or when that end is unknown). It lasts for its @duration, else
 * until `end`: the next Period's @start, or MPD@mediaPresentationDuration for the last Period.
 */
function periodTiming(
  node: XmlNode,
  previousEnd: number | undefined,
  end: number | undefined,
): PeriodTiming {
  const start = parseIsoDuration(attr(node, 'start')) ?? previousEnd ?? 0;
  const explicit = parseIsoDuration(attr(node, 'duration'));
  const duration = positive(explicit ?? (end !== undefined ? end - start : undefined));
  return duration !== undefined ? { start, duration } : { start };
}

function readPeriod(
  node: XmlNode,
  index: number,
  timing: PeriodTiming,
  parent: Inherited,
): DashPeriod {
  const context: Inherited = { ...descend(parent, node), periodDuration: timing.duration };
  return {
    id: attr(node, 'id') ?? `p${index}`,
    ...timing,
    representations: childrenNamed(node, 'AdaptationSet').flatMap((set, setIndex) =>
      readAdaptationSet(set, setIndex, context),
    ),
  };
}

function readAdaptationSet(node: XmlNode, index: number, parent: Inherited): DashRepresentation[] {
  const context = descend(parent, node);
  const set: AdaptationSetInfo = {
    id: attr(node, 'id') ?? `as${index}`,
    contentType: normalizeContentType(attr(node, 'contentType')),
    language: attr(node, 'lang'),
    label: firstChildNamed(node, 'Label')?.text.trim() || undefined,
    role: readRole(node),
  };
  return childrenNamed(node, 'Representation').map((rep, repIndex) =>
    readRepresentation(rep, repIndex, set, context),
  );
}

function readRepresentation(
  node: XmlNode,
  index: number,
  set: AdaptationSetInfo,
  parent: Inherited,
): DashRepresentation {
  const { baseUrl, common, manifestUrl, periodDuration, segmentInfo } = descend(parent, node);
  const bandwidth = attrNum(node, 'bandwidth');
  const codecs = common.codecs
    ?.split(',')
    .map((codec) => codec.trim())
    .filter(Boolean);

  return {
    id: attr(node, 'id') ?? `${set.id}-r${index}`,
    adaptationSetId: set.id,
    contentType:
      set.contentType !== 'unknown' ? set.contentType : contentTypeFromMime(common.mimeType),
    mimeType: common.mimeType,
    codecs: codecs && codecs.length > 0 ? codecs : undefined,
    bandwidth,
    width: common.width,
    height: common.height,
    frameRate: parseFrameRate(common.frameRate),
    audioChannels: common.audioChannels,
    language: attr(node, 'lang') ?? set.language,
    label: set.label,
    role: set.role,
    baseUrl,
    sizeBytes: estimateBytes(bandwidth, periodDuration),
    ...segmentAddressingFor(segmentInfo, baseUrl, manifestUrl),
  };
}

/** One level down: this node's BaseURL, segment information and common attributes apply. */
function descend(parent: Inherited, node: XmlNode): Inherited {
  return {
    ...parent,
    baseUrl: resolveBaseUrl(parent.baseUrl, node),
    segmentInfo: inheritSegmentInfo(parent.segmentInfo, node),
    common: inheritCommon(parent.common, node),
  };
}

/**
 * BaseURL is hierarchical: each level's BaseURL resolves against the one above it, the MPD's
 * against the MPD's own URL (5.6). Only the first is used; the others are alternative CDNs. An
 * unparseable BaseURL is ignored rather than allowed to break every URL below it.
 */
function resolveBaseUrl(parentBase: string, node: XmlNode): string {
  const value = firstChildNamed(node, 'BaseURL')?.text.trim();
  return (value && resolveUrl(value, parentBase)) || parentBase;
}

function inheritCommon(parent: CommonAttributes, node: XmlNode): CommonAttributes {
  const channels = firstChildNamed(node, 'AudioChannelConfiguration');
  return {
    mimeType: attr(node, 'mimeType') ?? parent.mimeType,
    codecs: attr(node, 'codecs') ?? parent.codecs,
    frameRate: attr(node, 'frameRate') ?? parent.frameRate,
    width: attrNum(node, 'width') ?? parent.width,
    height: attrNum(node, 'height') ?? parent.height,
    audioChannels: (channels && attrNum(channels, 'value')) ?? parent.audioChannels,
  };
}

/**
 * Every ContentProtection in the MPD, wherever it sits (5.8.4.1). Walking the whole tree instead
 * of only the levels read above means a descriptor in an unexpected place still counts: on the
 * DRM line, the parser errs towards refusing.
 */
function collectDrmSystems(root: XmlNode): string[] {
  const systems = new Set<string>();
  const visit = (node: XmlNode): void => {
    if (node.localName === 'ContentProtection') {
      const name = drmSystemName(node);
      if (name) systems.add(name);
    }
    node.children.forEach(visit);
  };
  visit(root);
  return [...systems];
}

/** The system's name (manifests/drm-systems.ts), else whatever the descriptor calls itself. */
function drmSystemName(descriptor: XmlNode): string | undefined {
  const scheme = attr(descriptor, 'schemeIdUri') ?? '';
  if (!scheme) return undefined;
  return drmSystemNamed(scheme) ?? attr(descriptor, 'value') ?? scheme;
}

function contentTypeFromMime(mime: string | undefined): DashContentType {
  return normalizeContentType(mime?.split('/')[0]);
}

function normalizeContentType(value: string | undefined): DashContentType {
  const type = value?.toLowerCase();
  if (type === 'video' || type === 'audio' || type === 'image') return type;
  if (type === 'text' || type === 'application') return 'text';
  return 'unknown';
}

/**
 * The AdaptationSet's role. An audio description for blind and partially
 * sighted viewers, or a commentary, is signalled in more than one way - a
 * "description" Role beside "main", or DVB's `<Accessibility>` AudioPurpose
 * (TV-Anytime: 1 description; 3 and 4 commentary) on a set whose Role is
 * "main" - and must read as such either way, or "best" would pair it with the
 * video as the programme's sound (ARCHITECTURE.md D20).
 */
function readRole(node: XmlNode): string | undefined {
  const roles = childrenNamed(node, 'Role').map((role) => attr(role, 'value'));
  const purposes = childrenNamed(node, 'Accessibility')
    .filter((entry) => /AudioPurposeCS/i.test(attr(entry, 'schemeIdUri') ?? ''))
    .map((entry) => attr(entry, 'value'));
  if (roles.includes('description') || purposes.includes('1')) return 'description';
  if (roles.includes('commentary') || purposes.includes('3') || purposes.includes('4')) {
    return 'commentary';
  }
  return roles[0];
}

/** Durations must be positive to mean anything; zero, negative and NaN become "unknown". */
function positive(seconds: number | undefined): number | undefined {
  return seconds !== undefined && seconds > 0 ? seconds : undefined;
}
