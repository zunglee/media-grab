/**
 * What a URL or a codec string is (PRD s5, s12).
 *
 * This module is the one rule set for "is this media, and what kind". DOM
 * detection, the page hook and the network observer all ask
 * `classifyMediaUrl`; the quality code asks `codecFamily` / `isAudioCodec`.
 * Both are driven by the tables below, so the answers cannot drift apart.
 */
import type { ContainerFormat, MediaKind, Protocol } from '../core/types.ts';

interface Identification {
  format: ContainerFormat;
  kind: MediaKind;
  protocol: Protocol;
}

/** Extension -> container. */
const EXTENSION_FORMATS: Record<string, Identification> = {
  mp4: { format: 'mp4', kind: 'video', protocol: 'progressive' },
  m4v: { format: 'm4v', kind: 'video', protocol: 'progressive' },
  mov: { format: 'mov', kind: 'video', protocol: 'progressive' },
  webm: { format: 'webm', kind: 'video', protocol: 'progressive' },
  mkv: { format: 'mkv', kind: 'video', protocol: 'progressive' },
  ts: { format: 'ts', kind: 'video', protocol: 'progressive' },
  m4s: { format: 'mp4', kind: 'video', protocol: 'progressive' },
  cmfv: { format: 'mp4', kind: 'video', protocol: 'progressive' },
  cmfa: { format: 'm4a', kind: 'audio', protocol: 'progressive' },
  mp3: { format: 'mp3', kind: 'audio', protocol: 'progressive' },
  m4a: { format: 'm4a', kind: 'audio', protocol: 'progressive' },
  aac: { format: 'aac', kind: 'audio', protocol: 'progressive' },
  ogg: { format: 'ogg', kind: 'audio', protocol: 'progressive' },
  oga: { format: 'ogg', kind: 'audio', protocol: 'progressive' },
  opus: { format: 'opus', kind: 'audio', protocol: 'progressive' },
  wav: { format: 'wav', kind: 'audio', protocol: 'progressive' },
  flac: { format: 'flac', kind: 'audio', protocol: 'progressive' },
  m3u8: { format: 'ts', kind: 'video', protocol: 'hls' },
  m3u: { format: 'ts', kind: 'video', protocol: 'hls' },
  mpd: { format: 'mp4', kind: 'video', protocol: 'dash' },
  vtt: { format: 'vtt', kind: 'subtitle', protocol: 'progressive' },
  webvtt: { format: 'vtt', kind: 'subtitle', protocol: 'progressive' },
  srt: { format: 'srt', kind: 'subtitle', protocol: 'progressive' },
  ttml: { format: 'ttml', kind: 'subtitle', protocol: 'progressive' },
  dfxp: { format: 'ttml', kind: 'subtitle', protocol: 'progressive' },
  ass: { format: 'ass', kind: 'subtitle', protocol: 'progressive' },
  ssa: { format: 'ass', kind: 'subtitle', protocol: 'progressive' },
  jpg: { format: 'jpg', kind: 'image', protocol: 'progressive' },
  jpeg: { format: 'jpg', kind: 'image', protocol: 'progressive' },
  png: { format: 'png', kind: 'image', protocol: 'progressive' },
  webp: { format: 'webp', kind: 'image', protocol: 'progressive' },
};

/** Content-Type -> container, including the legacy aliases servers still send. */
const MIME_FORMATS: Record<string, Identification> = {
  'video/mp4': { format: 'mp4', kind: 'video', protocol: 'progressive' },
  'video/iso.segment': { format: 'mp4', kind: 'video', protocol: 'progressive' },
  'video/x-m4v': { format: 'm4v', kind: 'video', protocol: 'progressive' },
  'video/webm': { format: 'webm', kind: 'video', protocol: 'progressive' },
  'video/matroska': { format: 'mkv', kind: 'video', protocol: 'progressive' },
  'video/x-matroska': { format: 'mkv', kind: 'video', protocol: 'progressive' },
  'video/quicktime': { format: 'mov', kind: 'video', protocol: 'progressive' },
  'video/mp2t': { format: 'ts', kind: 'video', protocol: 'progressive' },
  'video/ogg': { format: 'ogg', kind: 'video', protocol: 'progressive' },
  'audio/mpeg': { format: 'mp3', kind: 'audio', protocol: 'progressive' },
  'audio/mp3': { format: 'mp3', kind: 'audio', protocol: 'progressive' },
  'audio/mpeg3': { format: 'mp3', kind: 'audio', protocol: 'progressive' },
  'audio/x-mpeg-3': { format: 'mp3', kind: 'audio', protocol: 'progressive' },
  'audio/mp4': { format: 'm4a', kind: 'audio', protocol: 'progressive' },
  'audio/x-m4a': { format: 'm4a', kind: 'audio', protocol: 'progressive' },
  'audio/aac': { format: 'aac', kind: 'audio', protocol: 'progressive' },
  'audio/webm': { format: 'webm', kind: 'audio', protocol: 'progressive' },
  'audio/ogg': { format: 'ogg', kind: 'audio', protocol: 'progressive' },
  'audio/opus': { format: 'opus', kind: 'audio', protocol: 'progressive' },
  'audio/wav': { format: 'wav', kind: 'audio', protocol: 'progressive' },
  'audio/x-wav': { format: 'wav', kind: 'audio', protocol: 'progressive' },
  'audio/flac': { format: 'flac', kind: 'audio', protocol: 'progressive' },
  'audio/x-flac': { format: 'flac', kind: 'audio', protocol: 'progressive' },
  // HLS. The `audio/` spellings are inherited from .m3u audio playlists; servers
  // send them for video streams too, and manifest expansion sets the real kind.
  'application/vnd.apple.mpegurl': { format: 'ts', kind: 'video', protocol: 'hls' },
  'application/x-mpegurl': { format: 'ts', kind: 'video', protocol: 'hls' },
  'audio/mpegurl': { format: 'ts', kind: 'video', protocol: 'hls' },
  'audio/x-mpegurl': { format: 'ts', kind: 'video', protocol: 'hls' },
  'application/dash+xml': { format: 'mp4', kind: 'video', protocol: 'dash' },
  'text/vtt': { format: 'vtt', kind: 'subtitle', protocol: 'progressive' },
  'application/ttml+xml': { format: 'ttml', kind: 'subtitle', protocol: 'progressive' },
  'application/x-subrip': { format: 'srt', kind: 'subtitle', protocol: 'progressive' },
  'image/jpeg': { format: 'jpg', kind: 'image', protocol: 'progressive' },
  'image/png': { format: 'png', kind: 'image', protocol: 'progressive' },
  'image/webp': { format: 'webp', kind: 'image', protocol: 'progressive' },
};

/**
 * Real containers that `ContainerFormat` cannot name yet. They are identified
 * as `format: 'unknown'` with the right kind, and `fileExtensionFor` uses this
 * table so the file on disk still gets its honest extension.
 */
const EXTENSION_FOR_UNTYPED_MIME: Record<string, string> = {
  'video/x-flv': 'flv',
  'video/3gpp': '3gp',
  'audio/3gpp': '3gp',
  'video/3gpp2': '3g2',
  'audio/3gpp2': '3g2',
};

/** How much to trust each way of identifying a resource. */
const CONFIDENCE = {
  /** The server said exactly what it is. */
  mime: 0.95,
  /** The path says what it is; CDNs sometimes lie with extensions. */
  extension: 0.75,
  /** `video/*` or `audio/*` we have no table entry for: the kind is right, the container unknown. */
  mimeFamily: 0.5,
  /** Bytes inside the page (blob:, data:): identifiable, not fetchable from outside it. */
  inPage: 0.2,
  none: 0,
} as const;

export interface FormatGuess {
  format: ContainerFormat;
  kind: MediaKind;
  protocol: Protocol;
  /** 0-1: how much the caller should trust this guess. */
  confidence: number;
}

/**
 * Identify a resource from its URL and (when we have it) its Content-Type.
 * MIME wins over extension, because signed URLs frequently have no extension
 * at all and CDNs frequently serve `.mp4` paths that are really manifests.
 *
 * `blob:` and `data:` are never `progressive`, whatever their MIME type says:
 * they name bytes held by the page, and a MediaSource `blob:` URL cannot be
 * fetched by anyone, the downloads API included.
 */
export function guessFormat(url: string, mimeType?: string): FormatGuess {
  const inPage = url.startsWith('blob:') ? 'blob' : url.startsWith('data:') ? 'data' : undefined;
  const mime = normalizeMime(mimeType) ?? (inPage === 'data' ? dataUrlMime(url) : undefined);
  const fromMime = mime ? MIME_FORMATS[mime] : undefined;

  if (inPage) {
    return {
      format: fromMime?.format ?? 'unknown',
      kind: fromMime?.kind ?? kindOfMimeFamily(mime) ?? 'unknown',
      protocol: inPage,
      confidence: CONFIDENCE.inPage,
    };
  }

  if (fromMime) return { ...fromMime, confidence: CONFIDENCE.mime };

  const extension = extensionOf(url);
  const fromExtension = extension ? EXTENSION_FORMATS[extension] : undefined;
  if (fromExtension) return { ...fromExtension, confidence: CONFIDENCE.extension };

  const family = kindOfMimeFamily(mime);
  if (family) {
    return {
      format: 'unknown',
      kind: family,
      protocol: 'progressive',
      confidence: CONFIDENCE.mimeFamily,
    };
  }

  return { format: 'unknown', kind: 'unknown', protocol: 'unknown', confidence: CONFIDENCE.none };
}

function kindOfMimeFamily(mime: string | undefined): MediaKind | undefined {
  if (mime?.startsWith('video/')) return 'video';
  if (mime?.startsWith('audio/')) return 'audio';
  if (mime?.startsWith('image/')) return 'image';
  return undefined;
}

/** `data:video/mp4;base64,...` -> `video/mp4`. */
function dataUrlMime(url: string): string | undefined {
  const match = /^data:([^;,]*)/i.exec(url);
  return normalizeMime(match?.[1]);
}

/** What `classifyMediaUrl` says about a URL that is media. */
export interface MediaUrlClass {
  kind: MediaKind;
  protocol: Protocol;
  format: ContainerFormat;
  /**
   * One piece of a stream (an HLS/DASH media or init segment), not a file
   * anyone wants on its own. A page playing one video fetches thousands.
   */
  isSegment: boolean;
}

/**
 * The single answer to "is this URL media, and what is it". Returns null when
 * it is not media as far as detection is concerned: unidentifiable, or an
 * image (posters and thumbnails come from the DOM, where there is context to
 * tell a poster from a sprite sheet; a bare image URL cannot).
 *
 * Subtitles are media here. `blob:`/`data:` URLs are classified (their kind
 * matters for diagnosis) with protocol `blob`/`data`, which callers must treat
 * as not downloadable.
 */
export function classifyMediaUrl(url: string, mimeType?: string): MediaUrlClass | null {
  const guess = guessFormat(url, mimeType);
  if (guess.kind === 'unknown' || guess.kind === 'image') return null;
  return {
    kind: guess.kind,
    protocol: guess.protocol,
    format: guess.format,
    isSegment: isStreamSegment(url, guess, normalizeMime(mimeType)),
  };
}

/**
 * Extensions only ever used for stream segments. `.m4s` and CMAF track files
 * are segments by definition. `.ts` is MPEG-TS, which on the web is almost
 * only HLS segments (a standalone .ts recording is rare, and a `.ts` URL that
 * is not a segment is usually a TypeScript module, not media at all).
 */
const SEGMENT_EXTENSIONS = new Set(['ts', 'm4s', 'cmfv', 'cmfa']);

/**
 * A file name shaped like a segment: a segment word followed by a number or a
 * separator. `seg-12.ts`, `segment_3.m4s`, `chunk-stream0-00001.m4s`,
 * `init.mp4`, `init-stream0.m4s`, Apple's `fileSequence12.aac`.
 * Whole words only, so `chunky-monkey.mp4` and `initial-d.mp4` are files.
 */
const SEGMENT_FILENAME =
  /(?:^|[-_.])(?:seg(?:ment)?|chunk|frag(?:ment)?|init|filesequence)(?=[-_.\d])/i;

/** A directory that holds segments: `/frag/12.mp4`, `/segments/3.m4a`. */
const SEGMENT_DIRECTORY = /\/(?:segments?|chunks?|frags?|fragments?)\//i;

/** Smooth Streaming: `.../QualityLevels(3000000)/Fragments(video=123456)`. */
const SMOOTH_FRAGMENT = /\/Fragments\([^)]*\)$/i;

function isStreamSegment(url: string, guess: Identification, mime: string | undefined): boolean {
  if (guess.protocol !== 'progressive') return false;
  if (guess.format === 'ts' || mime === 'video/iso.segment') return true;
  const extension = extensionOf(url);
  if (extension && SEGMENT_EXTENSIONS.has(extension)) return true;
  const path = pathnameOf(url);
  const filename = path.slice(path.lastIndexOf('/') + 1);
  return (
    SEGMENT_FILENAME.test(filename) || SEGMENT_DIRECTORY.test(path) || SMOOTH_FRAGMENT.test(path)
  );
}

function pathnameOf(url: string): string {
  try {
    return new URL(url, 'https://placeholder.invalid').pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

export function extensionOf(url: string): string | null {
  const pathname = pathnameOf(url);
  const filename = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return null;
  const extension = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,6}$/.test(extension) ? extension : null;
}

export function normalizeMime(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  return mimeType.split(';')[0]?.trim().toLowerCase() || undefined;
}

/**
 * Extension to use when writing the file to disk. Pass the MIME type when you
 * have it: it names containers `ContainerFormat` cannot (FLV, 3GP).
 */
export function fileExtensionFor(
  format: ContainerFormat,
  kind: MediaKind,
  mimeType?: string,
): string {
  if (format !== 'unknown') return format;
  const untyped = EXTENSION_FOR_UNTYPED_MIME[normalizeMime(mimeType) ?? ''];
  if (untyped) return untyped;
  if (kind === 'audio') return 'm4a';
  if (kind === 'video') return 'mp4';
  if (kind === 'image') return 'jpg';
  if (kind === 'subtitle') return 'vtt';
  return 'bin';
}

type Track = 'video' | 'audio';

/**
 * RFC 6381 codec string prefix -> family and the track it carries. Matched on
 * the lowercased string, first match wins, so specific prefixes come first
 * (`mp4a.69` before `mp4a`). Families are what the quality score weighs.
 *
 * Dolby Vision is reported as the codec it layers on (dvh1/dvhe over HEVC,
 * dva1/dvav over H.264, dav1 over AV1): that is what decides efficiency.
 */
const CODECS: ReadonlyArray<readonly [prefix: string, family: string, track: Track]> = [
  ['av01', 'av1', 'video'],
  ['dav1', 'av1', 'video'],
  ['hvc1', 'hevc', 'video'],
  ['hev1', 'hevc', 'video'],
  ['dvh1', 'hevc', 'video'],
  ['dvhe', 'hevc', 'video'],
  ['vvc1', 'vvc', 'video'],
  ['vvi1', 'vvc', 'video'],
  ['vp09', 'vp9', 'video'],
  ['vp9', 'vp9', 'video'],
  ['vp08', 'vp8', 'video'],
  ['vp8', 'vp8', 'video'],
  ['avc1', 'h264', 'video'],
  ['avc3', 'h264', 'video'],
  ['dva1', 'h264', 'video'],
  ['dvav', 'h264', 'video'],
  ['h264', 'h264', 'video'],
  // MPEG-4 Part 2 (and MPEG-1/2 video carried in MP4).
  ['mp4v', 'mpeg4', 'video'],
  ['theora', 'theora', 'video'],
  // MP3, AC-3 and E-AC-3 carried in MP4 under an `mp4a` object type.
  ['mp4a.40.34', 'mp3', 'audio'],
  ['mp4a.69', 'mp3', 'audio'],
  ['mp4a.6b', 'mp3', 'audio'],
  ['mp4a.a5', 'ac3', 'audio'],
  ['mp4a.a6', 'eac3', 'audio'],
  ['mp4a', 'aac', 'audio'],
  ['mp3', 'mp3', 'audio'],
  ['opus', 'opus', 'audio'],
  ['ec-3', 'eac3', 'audio'],
  ['ac-3', 'ac3', 'audio'],
  ['ac-4', 'ac4', 'audio'],
  ['flac', 'flac', 'audio'],
  ['vorbis', 'vorbis', 'audio'],
  ['alac', 'alac', 'audio'],
  ['dts', 'dts', 'audio'],
  ['mha1', 'mpegh', 'audio'],
  ['mhm1', 'mpegh', 'audio'],
];

function lookupCodec(codec: string): readonly [string, string, Track] | undefined {
  const c = codec.trim().toLowerCase();
  return CODECS.find(([prefix]) => c.startsWith(prefix));
}

/** Codec string -> family (`avc1.640028` -> `h264`). Unknown codecs come back lowercased. */
export function codecFamily(codec: string): string {
  return lookupCodec(codec)?.[1] ?? codec.trim().toLowerCase();
}

export function isAudioCodec(codec: string): boolean {
  return lookupCodec(codec)?.[2] === 'audio';
}

/** Decide what a codec list actually carries. A DASH video Representation has only video. */
export function tracksFromCodecs(
  codecs: string[] | undefined,
): { video: boolean; audio: boolean } | undefined {
  if (!codecs || codecs.length === 0) return undefined;
  let video = false;
  let audio = false;
  for (const codec of codecs) {
    const track = lookupCodec(codec)?.[2];
    if (track === 'video') video = true;
    else if (track === 'audio') audio = true;
  }
  if (!video && !audio) return undefined;
  return { video, audio };
}
