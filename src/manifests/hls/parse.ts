/**
 * HLS playlist parser (RFC 8216). Pure functions, no network, no browser APIs.
 *
 * Two shapes exist and a client cannot know which it has until it reads the
 * tags: a MASTER playlist lists variants, a MEDIA playlist lists segments.
 * `parseHlsPlaylist` returns a discriminated union so callers must handle both.
 *
 * Only what the detector and the downloader read is kept. URIs are returned as
 * written; callers resolve them against the playlist's own URL (manifests/url.ts).
 */
import { ErrorCode, MediaGrabError } from '../../core/errors.ts';
import { drmSystemNamed } from '../drm-systems.ts';
import {
  attrBool,
  attrCodecs,
  attrFrameRate,
  attrNumber,
  attrResolution,
  parseAttributeList,
  parseByteRange,
} from './attributes.ts';

export interface ByteRange {
  length: number;
  /** Absent: continues where the previous sub-range of the same resource ended (s4.3.2.2). */
  offset?: number;
}

/** One EXT-X-STREAM-INF entry of a master playlist (s4.3.4.2). */
export interface HlsStreamInf {
  uri: string;
  /** Peak bits per second. Required by the spec; 0 when a playlist omits it anyway. */
  bandwidth: number;
  averageBandwidth?: number;
  resolution?: { width: number; height: number };
  frameRate?: number;
  codecs?: string[];
  /** The EXT-X-MEDIA TYPE=AUDIO group this variant plays with. */
  audioGroupId?: string;
  subtitleGroupId?: string;
}

/** One EXT-X-MEDIA entry: an alternative audio, video or subtitle rendition (s4.3.4.1). */
export interface HlsMediaRendition {
  type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';
  groupId: string;
  name: string;
  /**
   * Absent means the rendition's media is inside the variant stream itself
   * (s4.3.4.2.1); present means it is a separate playlist, so a variant in this
   * group carries no audio of its own.
   */
  uri?: string;
  language?: string;
  default: boolean;
  forced: boolean;
  /**
   * An audio description for blind and partially sighted viewers
   * (CHARACTERISTICS `public.accessibility.describes-video`, s4.4.6.1): never
   * the track to pair with a video by default (ARCHITECTURE.md D20).
   */
  describesVideo: boolean;
}

export interface HlsSegment {
  uri: string;
  /** Seconds, from EXTINF. Never negative. */
  duration: number;
  byteRange?: ByteRange;
  /** EXT-X-MAP in force for this segment: fMP4 (CMAF) segments need it first. */
  init?: { uri: string; byteRange?: ByteRange };
  /** EXT-X-GAP (RFC 8216bis): the server says this segment is missing, so it is never fetched. */
  gap: boolean;
}

export interface HlsMasterPlaylist {
  kind: 'master';
  variants: HlsStreamInf[];
  renditions: HlsMediaRendition[];
  /** A master playlist declares protection up front only through EXT-X-SESSION-KEY. */
  drm: boolean;
  drmSystems: string[];
}

export interface HlsMediaPlaylist {
  kind: 'media';
  /** No EXT-X-ENDLIST and not a VOD playlist: the server is still appending segments. */
  live: boolean;
  segments: HlsSegment[];
  /** Sum of segment durations, seconds. */
  totalDuration: number;
  /**
   * Some EXT-X-KEY applies a METHOD other than NONE. That includes plain
   * AES-128, which is not DRM but which this build does not decrypt either.
   */
  encrypted: boolean;
  /** Encrypted by a DRM system (SAMPLE-AES, or a key format other than identity). */
  drm: boolean;
  drmSystems: string[];
  /** EXT-X-I-FRAMES-ONLY: trick-play frames, not a watchable stream. */
  iframesOnly: boolean;
}

export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylist;

/** Encryption methods that always mean a DRM system, whatever the key format. */
const DRM_METHODS = new Set(['SAMPLE-AES', 'SAMPLE-AES-CTR', 'SAMPLE-AES-CENC']);

export function isMasterPlaylist(text: string): boolean {
  return /^#EXT-X-STREAM-INF:/m.test(text);
}

export function looksLikeHls(text: string): boolean {
  return /^\s*#EXTM3U/.test(text);
}

/** Throws UNSUPPORTED_MANIFEST for anything that is not an HLS playlist. */
export function parseHlsPlaylist(text: string): HlsPlaylist {
  const lines = splitLines(text);
  if (!lines[0]?.startsWith('#EXTM3U')) {
    throw new MediaGrabError(
      ErrorCode.UNSUPPORTED_MANIFEST,
      'This is not an HLS playlist (it does not start with #EXTM3U).',
    );
  }
  return isMasterPlaylist(text) ? parseMaster(lines) : parseMedia(lines);
}

/** Trimming also removes a UTF-8 byte-order mark and the CR of CRLF line ends. */
function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseMaster(lines: string[]): HlsMasterPlaylist {
  const variants: HlsStreamInf[] = [];
  const renditions: HlsMediaRendition[] = [];
  const drmSystems = new Set<string>();
  // EXT-X-STREAM-INF describes the URI on the NEXT line (s4.3.4.2).
  let pendingStreamInf: Map<string, string> | null = null;

  for (const line of lines) {
    if (!line.startsWith('#')) {
      if (pendingStreamInf) variants.push(streamInfFrom(pendingStreamInf, line));
      pendingStreamInf = null;
      continue;
    }

    const [tag, rest] = splitTag(line);
    if (tag === '#EXT-X-STREAM-INF') {
      pendingStreamInf = parseAttributeList(rest);
    } else if (tag === '#EXT-X-MEDIA') {
      const rendition = mediaRenditionFrom(parseAttributeList(rest));
      if (rendition) renditions.push(rendition);
    } else if (tag === '#EXT-X-SESSION-KEY') {
      const attrs = parseAttributeList(rest);
      const system = drmSystemFor(attrs.get('METHOD') ?? '', attrs.get('KEYFORMAT') ?? 'identity');
      if (system) drmSystems.add(system);
    }
    // EXT-X-I-FRAME-STREAM-INF is trick-play only, never a download; the rest
    // do not change what can be downloaded.
  }

  return {
    kind: 'master',
    variants,
    renditions,
    drm: drmSystems.size > 0,
    drmSystems: [...drmSystems],
  };
}

function streamInfFrom(attrs: Map<string, string>, uri: string): HlsStreamInf {
  const resolution = attrResolution(attrs);
  const frameRate = attrFrameRate(attrs);
  const codecs = attrCodecs(attrs);
  const averageBandwidth = attrNumber(attrs, 'AVERAGE-BANDWIDTH');
  const audioGroupId = attrs.get('AUDIO');
  const subtitleGroupId = attrs.get('SUBTITLES');
  return {
    uri,
    bandwidth: attrNumber(attrs, 'BANDWIDTH') ?? 0,
    ...(averageBandwidth !== undefined ? { averageBandwidth } : {}),
    ...(resolution ? { resolution } : {}),
    ...(frameRate !== undefined ? { frameRate } : {}),
    ...(codecs ? { codecs } : {}),
    ...(audioGroupId !== undefined ? { audioGroupId } : {}),
    ...(subtitleGroupId !== undefined ? { subtitleGroupId } : {}),
  };
}

const RENDITION_TYPES = new Set<HlsMediaRendition['type']>([
  'AUDIO',
  'VIDEO',
  'SUBTITLES',
  'CLOSED-CAPTIONS',
]);

function mediaRenditionFrom(attrs: Map<string, string>): HlsMediaRendition | null {
  const type = attrs.get('TYPE') as HlsMediaRendition['type'] | undefined;
  const groupId = attrs.get('GROUP-ID');
  if (!type || !RENDITION_TYPES.has(type) || !groupId) return null;
  const uri = attrs.get('URI');
  const language = attrs.get('LANGUAGE');
  return {
    type,
    groupId,
    name: attrs.get('NAME') ?? groupId,
    ...(uri !== undefined ? { uri } : {}),
    ...(language !== undefined ? { language } : {}),
    default: attrBool(attrs, 'DEFAULT'),
    forced: attrBool(attrs, 'FORCED'),
    describesVideo: (attrs.get('CHARACTERISTICS') ?? '')
      .split(',')
      .some((tag) => tag.trim() === 'public.accessibility.describes-video'),
  };
}

function parseMedia(lines: string[]): HlsMediaPlaylist {
  const segments: HlsSegment[] = [];
  const drmSystems = new Set<string>();
  let endList = false;
  let vod = false;
  let iframesOnly = false;
  let encrypted = false;

  // Tags before a URI line describe that one segment; EXT-X-MAP and EXT-X-KEY
  // stay in force for every segment after them (s4.3.2).
  let next: { duration?: number; byteRange?: ByteRange; gap: boolean } = { gap: false };
  let init: HlsSegment['init'];

  for (const line of lines) {
    if (!line.startsWith('#')) {
      if (next.duration !== undefined) {
        segments.push({
          uri: line,
          duration: next.duration,
          ...(next.byteRange ? { byteRange: next.byteRange } : {}),
          ...(init ? { init } : {}),
          gap: next.gap,
        });
      }
      next = { gap: false };
      continue;
    }

    const [tag, rest] = splitTag(line);
    switch (tag) {
      case '#EXTINF':
        next.duration = extinfSeconds(rest);
        break;
      case '#EXT-X-BYTERANGE': {
        const byteRange = parseByteRange(rest);
        if (byteRange) next.byteRange = byteRange;
        break;
      }
      case '#EXT-X-GAP':
        next.gap = true;
        break;
      case '#EXT-X-PLAYLIST-TYPE':
        vod = rest.trim().toUpperCase() === 'VOD';
        break;
      case '#EXT-X-ENDLIST':
        endList = true;
        break;
      case '#EXT-X-I-FRAMES-ONLY':
        iframesOnly = true;
        break;
      case '#EXT-X-MAP': {
        const attrs = parseAttributeList(rest);
        const uri = attrs.get('URI');
        const byteRange = parseByteRange(attrs.get('BYTERANGE') ?? '');
        if (uri) init = byteRange ? { uri, byteRange } : { uri };
        break;
      }
      case '#EXT-X-KEY': {
        const attrs = parseAttributeList(rest);
        const method = (attrs.get('METHOD') ?? 'NONE').toUpperCase();
        if (method === 'NONE') break;
        encrypted = true;
        const system = drmSystemFor(method, attrs.get('KEYFORMAT') ?? 'identity');
        if (system) drmSystems.add(system);
        break;
      }
      default:
        break;
    }
  }

  return {
    kind: 'media',
    live: !endList && !vod,
    segments,
    totalDuration: segments.reduce((sum, segment) => sum + segment.duration, 0),
    encrypted,
    drm: drmSystems.size > 0,
    drmSystems: [...drmSystems],
    iframesOnly,
  };
}

/**
 * `#EXTINF:<duration>,[<title>]` (s4.3.2.1). Some encoders write -1 or junk
 * for an unknown duration; that counts as 0 rather than subtracting from the
 * total or poisoning it with NaN.
 */
function extinfSeconds(rest: string): number {
  const comma = rest.indexOf(',');
  const seconds = Number(comma === -1 ? rest : rest.slice(0, comma));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/**
 * The DRM system behind an EXT-X-KEY, or null for encryption that is not DRM:
 * AES-128 with the default `identity` key format, which this build refuses for
 * a different reason (it does not decrypt; README "Known limitations").
 * A key format nobody recognises is reported by its own name - never as clear.
 */
export function drmSystemFor(method: string, keyFormat: string): string | null {
  const named = drmSystemNamed(keyFormat);
  if (named) return named;
  if (DRM_METHODS.has(method.toUpperCase())) return 'Sample-AES';
  const format = keyFormat.trim().toLowerCase();
  if (format !== 'identity' && format !== '') return keyFormat;
  return null;
}

function splitTag(line: string): [string, string] {
  const colon = line.indexOf(':');
  if (colon === -1) return [line, ''];
  return [line.slice(0, colon), line.slice(colon + 1)];
}
