/**
 * Core domain types shared by every layer (detection, intelligence, downloads, UI).
 * Nothing in here may import a browser API - this module must stay unit-testable in Node.
 */

/** How a candidate reached us. Ordered loosely by trustworthiness. */
export type DetectionSource =
  | 'dom-element' // <video>/<audio>/<source> in the page DOM
  | 'dom-attribute' // data-src, poster, og:video, JSON-LD
  | 'network' // observed by the background network listener
  | 'page-hook' // seen from inside the page: its fetch/XHR calls, or its Resource Timing entries
  | 'adapter'; // produced by a site adapter

export type MediaKind = 'video' | 'audio' | 'image' | 'subtitle' | 'unknown';

/** Delivery protocol, not the URL scheme. */
export type Protocol = 'progressive' | 'hls' | 'dash' | 'blob' | 'data' | 'unknown';

export type ContainerFormat =
  | 'mp4'
  | 'webm'
  | 'mkv'
  | 'mov'
  | 'm4v'
  | 'ts'
  | 'mp3'
  | 'aac'
  | 'm4a'
  | 'ogg'
  | 'opus'
  | 'wav'
  | 'flac'
  | 'vtt'
  | 'srt'
  | 'ttml'
  | 'ass'
  | 'jpg'
  | 'png'
  | 'webp'
  | 'unknown';

/** What a stream actually carries. A DASH video-only representation is `{video:true,audio:false}`. */
export interface TrackFlags {
  video: boolean;
  audio: boolean;
}

export interface Resolution {
  width: number;
  height: number;
}

/**
 * One detected media resource, before or after intelligence processing.
 * `id` is a stable fingerprint (see media/fingerprint.ts), not a random uuid,
 * so the same resource seen twice from two sources collapses into one entry.
 */
export interface MediaCandidate {
  id: string;
  url: string;
  /** Original page the media belongs to. Used for naming and history, never uploaded. */
  pageUrl: string;
  pageTitle?: string;
  /** Frame that reported it; 0 is the top frame. */
  frameId?: number;
  kind: MediaKind;
  protocol: Protocol;
  format: ContainerFormat;
  mimeType?: string;
  source: DetectionSource;
  /** ms since epoch, when first seen. */
  seenAt: number;

  resolution?: Resolution;
  /** bits per second, as advertised by the manifest or measured from headers. */
  bitrate?: number;
  fps?: number;
  /** seconds */
  duration?: number;
  /** bytes, from Content-Length or a manifest size estimate. `estimated` says which. */
  sizeBytes?: number;
  sizeEstimated?: boolean;
  tracks: TrackFlags;
  codecs?: string[];
  /** BCP-47 where the source gives us one. */
  language?: string;
  label?: string;
  posterUrl?: string;
  title?: string;

  /** Populated for hls/dash parents: the selectable renditions underneath. */
  variants?: MediaVariant[];
  /** Audio renditions that must be muxed with a video-only variant. */
  audioTracks?: MediaVariant[];
  subtitles?: SubtitleTrack[];

  /** Set by the intelligence layer. 0-100. */
  score?: number;
  /** Human-readable reasons behind the score, surfaced in debug mode. */
  scoreReasons?: string[];
  /** True when the source told us this is a live/event stream. */
  live?: boolean;
  /** True when a manifest advertised encryption we must not touch. */
  drm?: boolean;
  drmSystem?: string;
  /**
   * Whether MediaGrab can save this, or why not (ARCHITECTURE.md D21). Decided
   * during the scan (detection/saveability.ts). Absent means nothing was
   * decided: a manifest the scan did not read, or a scan from an older build.
   */
  saveability?: Saveability;
}

/** A selectable rendition inside an HLS master playlist or a DASH period. */
export interface MediaVariant {
  id: string;
  url: string;
  kind: MediaKind;
  protocol: Protocol;
  format: ContainerFormat;
  bandwidth?: number;
  averageBandwidth?: number;
  resolution?: Resolution;
  fps?: number;
  codecs?: string[];
  tracks: TrackFlags;
  language?: string;
  label?: string;
  /** HLS: the AUDIO group this video variant expects. */
  audioGroupId?: string;
  /** HLS: the SUBTITLES group this video variant expects. */
  subtitleGroupId?: string;
  /** DASH: representation + adaptation set ids, needed to rebuild segment URLs. */
  dashRepresentationId?: string;
  dashAdaptationSetId?: string;
  /** Approximate byte size when duration and bandwidth are both known. */
  sizeBytes?: number;
  sizeEstimated?: boolean;
  /**
   * An audio track the manifest plays unless told otherwise: HLS DEFAULT=YES,
   * or DASH Role "main". media/quality.ts `pairAudioFor` prefers it.
   */
  default?: boolean;
  /**
   * DASH audio: the AdaptationSet's Role (main, dub, description, commentary,
   * ...). `pairAudioFor` passes over audio description and commentary while the
   * programme's own sound is on offer.
   */
  role?: string;
  score?: number;
  /**
   * Segments a download of this rendition would fetch, where the scan could
   * count them. The count stops one past the plan cap, like the plan itself
   * (manifests/segment-plan.ts MAX_PLAN_SEGMENTS).
   */
  segmentCount?: number;
  /**
   * Set only where this rendition differs from its candidate: a rendition too
   * large to assemble, in a ladder whose smaller renditions are fine (D21).
   */
  saveability?: Saveability;
}

/**
 * Whether a candidate or a rendition can be saved, and if not, the one reason
 * why (ARCHITECTURE.md D21). The user's words for each are in
 * ui/lib/media-view.ts.
 */
export type Saveability =
  | 'saveable'
  /** A DRM system protects it. MediaGrab never removes DRM. */
  | 'drm'
  /** Encrypted without DRM (HLS AES-128): MediaGrab does not decrypt, and encrypted bytes do not play. */
  | 'encrypted'
  /** No end yet. MediaGrab saves finished media, it does not record. */
  | 'live'
  /** A DASH stream of several Periods (usually adverts spliced in), which cannot be joined into one file. */
  | 'multi-period'
  /** Only the page's player holds the bytes (a `blob:` URL fed by MediaSource). */
  | 'media-source'
  /** Above the in-memory assembly ceiling, or more segments than one plan may hold. */
  | 'too-large'
  /** The manifest lists nothing MediaGrab can fetch. */
  | 'no-rendition';

export interface SubtitleTrack {
  id: string;
  url: string;
  format: ContainerFormat;
  language?: string;
  label?: string;
  /** HLS FORCED / DASH forced-subtitle role. */
  forced?: boolean;
  default?: boolean;
}

/**
 * What a page shows about its player beyond the URLs found on it. Reported per
 * frame by the content script, summed per tab by the worker, read by diagnosis.
 */
export interface PageSignals {
  /** A MediaSource feeds a player: the media is assembled in JavaScript, so no single file exists. */
  hasMediaSource: boolean;
  /** MediaKeys are attached to a player: a DRM licence is in play. */
  hasMediaKeys: boolean;
  /** `<video>` and `<audio>` elements. */
  mediaElements: number;
  /** Cross-origin iframes that look like embedded players (detection/dom.ts says how). */
  playerFrames: number;
}

/** Aggregated result of a page scan, what the popup renders. */
export interface ScanResult {
  tabId: number;
  pageUrl: string;
  pageTitle: string;
  scannedAt: number;
  candidates: MediaCandidate[];
  /** Everything the engine saw and rejected, for debug mode. Never shown by default. */
  rejected: RejectedCandidate[];
  stats: ScanStats;
  /** Set when nothing usable was found, drives the "why can't I download this?" panel. */
  diagnosis?: Diagnosis;
}

export interface RejectedCandidate {
  url: string;
  reason: string;
}

export interface ScanStats {
  networkRequestsObserved: number;
  /** `<video>`/`<audio>` elements across the tab's frames. */
  mediaElements: number;
  candidatesRaw: number;
  candidatesAfterDedupe: number;
  manifestsParsed: number;
  byProtocol: Record<Protocol, number>;
  parseErrors: number;
}

export interface Diagnosis {
  code: DiagnosisCode;
  reasons: string[];
}

export type DiagnosisCode =
  | 'NO_MEDIA_YET'
  | 'DRM_PROTECTED'
  | 'MSE_ONLY'
  | 'CROSS_ORIGIN_FRAME'
  | 'NOT_STARTED'
  | 'UNSUPPORTED_PLAYER';
