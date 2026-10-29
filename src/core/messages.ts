import type { DownloadTaskView } from './download-types.ts';
import {
  MAX_CANDIDATES_PER_FRAME,
  MAX_FRAME_DIMENSION,
  MAX_MIME_LENGTH,
  MAX_REPORT_CLAIM_CHARS,
  MAX_REPORTED_COUNT,
  MAX_SUBTITLES_PER_CLAIM,
  MAX_TITLE_LENGTH,
  MAX_URL_LENGTH,
} from './limits.ts';
import type { MediaKind, PageSignals, Resolution, ScanResult } from './types.ts';

/**
 * The only channel between content scripts, the background worker and the UI.
 * Every message is validated by `parseMessage` before it is acted on - a content
 * script runs in a hostile page, so its output is untrusted input (SECURITY.md).
 *
 *   content script ──PAGE_REPORT──────────────────────────────> background
 *   popup / options ──REQUEST_SCAN / GET_SCAN / START_DOWNLOAD
 *                     DOWNLOAD_COMMAND / GET_DOWNLOADS
 *                     SETTINGS_CHANGED─────────────────────────> background
 *   background ──SCAN_RESULT / DOWNLOADS_STATE (broadcast)────> popup
 *   background ──REQUEST_SCAN──────────────────────────────────> content script
 */

/**
 * Everything one frame knows about itself, sent as ONE message so the worker
 * never sees half a picture. It is always the full current state of that frame
 * (not a delta), which makes a lost or reordered report harmless: the next one
 * replaces it.
 */
export interface PageReport {
  pageUrl: string;
  pageTitle: string;
  /**
   * When the page this frame shows began, in ms since the epoch: the
   * document's time origin for a new document, or the moment a pushState /
   * popstate route change or a back-forward-cache restore put a different page
   * on screen. A top-frame report with a new value is a navigation, whatever the
   * URL says - an address tidied by replaceState is still the same page.
   */
  routeStartedAt: number;
  signals: PageSignals;
  /** og:image / twitter:image / JSON-LD thumbnail, for candidates with no poster. */
  pagePoster?: string;
  candidates: ReportedCandidate[];
}

/** Where on a page a reported URL was found. The worker's own sources are not claimable. */
export type ReportedSource = 'dom-element' | 'dom-attribute' | 'page-hook';

/**
 * A page's claim that a URL is media: the URL plus what the page itself says
 * about it. Deliberately not a MediaCandidate - protocol, format, id, score,
 * variants and the DRM verdict are the worker's to decide, never a page's
 * (detection/candidate.ts rebuilds the candidate from this).
 */
export interface ReportedCandidate {
  url: string;
  kind: MediaKind;
  source: ReportedSource;
  mimeType?: string;
  title?: string;
  posterUrl?: string;
  /** Seconds. */
  duration?: number;
  resolution?: Resolution;
  subtitles?: ReportedSubtitle[];
}

export interface ReportedSubtitle {
  url: string;
  language?: string;
  label?: string;
  default?: boolean;
}

export type DownloadCommand = 'pause' | 'resume' | 'cancel' | 'retry';

export type ExtensionMessage =
  | ({ type: 'PAGE_REPORT' } & PageReport)
  | { type: 'REQUEST_SCAN'; tabId?: number }
  | { type: 'SCAN_RESULT'; result: ScanResult }
  | { type: 'GET_SCAN'; tabId: number }
  | { type: 'START_DOWNLOAD'; candidateId: string; variantId?: string; tabId: number }
  | { type: 'DOWNLOAD_COMMAND'; taskId: string; command: DownloadCommand }
  | { type: 'DOWNLOADS_STATE'; tasks: DownloadTaskView[] }
  | { type: 'GET_DOWNLOADS' }
  | { type: 'SETTINGS_CHANGED' };

type MessageType = ExtensionMessage['type'];

/**
 * Who may send what. A content script lives inside a web page, so the only
 * thing the worker accepts from one is a report about that page; everything
 * that starts a download or changes settings must come from our own pages.
 */
const FROM_CONTENT_SCRIPT = new Set<MessageType>(['PAGE_REPORT']);
const FROM_EXTENSION_PAGE = new Set<MessageType>([
  'REQUEST_SCAN',
  'GET_SCAN',
  'START_DOWNLOAD',
  'DOWNLOAD_COMMAND',
  'GET_DOWNLOADS',
  'SETTINGS_CHANGED',
]);
const FROM_WORKER = new Set<MessageType>(['SCAN_RESULT', 'DOWNLOADS_STATE']);

export function acceptsFromContentScript(type: MessageType): boolean {
  return FROM_CONTENT_SCRIPT.has(type);
}

export function acceptsFromExtensionPage(type: MessageType): boolean {
  return FROM_EXTENSION_PAGE.has(type);
}

/**
 * Shape gate. Returns null instead of throwing so a malformed message from a
 * compromised page is dropped silently rather than crashing the worker.
 */
export function parseMessage(raw: unknown): ExtensionMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;

  switch (type) {
    case 'PAGE_REPORT': {
      if (typeof r.pageUrl !== 'string' || typeof r.pageTitle !== 'string') return null;
      if (!Array.isArray(r.candidates)) return null;
      const signals = (r.signals ?? {}) as Record<string, unknown>;
      const poster = httpUrl(r.pagePoster);
      return {
        type,
        pageUrl: r.pageUrl.slice(0, MAX_URL_LENGTH),
        pageTitle: r.pageTitle.slice(0, MAX_TITLE_LENGTH),
        routeStartedAt: finitePositive(r.routeStartedAt) ?? 0,
        signals: {
          hasMediaSource: signals.hasMediaSource === true,
          hasMediaKeys: signals.hasMediaKeys === true,
          mediaElements: count(signals.mediaElements),
          playerFrames: count(signals.playerFrames),
        },
        ...(poster ? { pagePoster: poster } : {}),
        candidates: withinBudget(
          r.candidates
            .slice(0, MAX_CANDIDATES_PER_FRAME)
            .map(parseReportedCandidate)
            .filter((candidate): candidate is ReportedCandidate => candidate !== null),
        ),
      };
    }
    case 'START_DOWNLOAD': {
      if (typeof r.candidateId !== 'string' || typeof r.tabId !== 'number') return null;
      return {
        type,
        candidateId: r.candidateId,
        tabId: r.tabId,
        ...(typeof r.variantId === 'string' ? { variantId: r.variantId } : {}),
      };
    }
    case 'DOWNLOAD_COMMAND': {
      const command = r.command;
      if (typeof r.taskId !== 'string') return null;
      if (
        command !== 'pause' &&
        command !== 'resume' &&
        command !== 'cancel' &&
        command !== 'retry'
      ) {
        return null;
      }
      return { type, taskId: r.taskId, command };
    }
    case 'GET_SCAN': {
      if (typeof r.tabId !== 'number') return null;
      return { type, tabId: r.tabId };
    }
    case 'REQUEST_SCAN': {
      return { type, ...(typeof r.tabId === 'number' ? { tabId: r.tabId } : {}) };
    }
    case 'GET_DOWNLOADS':
    case 'SETTINGS_CHANGED':
      return { type };
    default:
      // SCAN_RESULT / DOWNLOADS_STATE are broadcast by the worker, which we
      // trust; they are passed through unchanged for the UI.
      return typeof type === 'string' && FROM_WORKER.has(type as MessageType)
        ? (raw as ExtensionMessage)
        : null;
  }
}

const REPORTABLE_KINDS = new Set<MediaKind>(['video', 'audio', 'subtitle', 'unknown']);
const REPORTABLE_SOURCES = new Set<ReportedSource>(['dom-element', 'dom-attribute', 'page-hook']);

/**
 * Allow-list, field by field: only what a page can honestly know about a URL
 * it shows, each value checked and bounded. Only http(s) URLs pass - a page
 * can put `javascript:` or `data:` in an href, and neither is a download.
 */
export function parseReportedCandidate(raw: unknown): ReportedCandidate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const url = httpUrl(c.url);
  const kind = c.kind as MediaKind;
  const source = c.source as ReportedSource;
  if (!url || !REPORTABLE_KINDS.has(kind) || !REPORTABLE_SOURCES.has(source)) return null;

  const mimeType = text(c.mimeType, MAX_MIME_LENGTH);
  const title = text(c.title, MAX_TITLE_LENGTH);
  const posterUrl = httpUrl(c.posterUrl);
  const duration = finitePositive(c.duration);
  const resolution = resolutionOf(c.resolution);
  const subtitles = Array.isArray(c.subtitles)
    ? c.subtitles
        .slice(0, MAX_SUBTITLES_PER_CLAIM)
        .map(parseSubtitle)
        .filter((track): track is ReportedSubtitle => track !== null)
    : [];

  return {
    url,
    kind,
    source,
    ...(mimeType ? { mimeType } : {}),
    ...(title ? { title } : {}),
    ...(posterUrl ? { posterUrl } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(resolution ? { resolution } : {}),
    ...(subtitles.length > 0 ? { subtitles } : {}),
  };
}

/** The claims that fit in MAX_REPORT_CLAIM_CHARS, in the order the page sent them. */
function withinBudget(claims: ReportedCandidate[]): ReportedCandidate[] {
  let used = 0;
  const kept: ReportedCandidate[] = [];
  for (const claim of claims) {
    used += JSON.stringify(claim).length;
    if (used > MAX_REPORT_CLAIM_CHARS) break;
    kept.push(claim);
  }
  return kept;
}

function parseSubtitle(raw: unknown): ReportedSubtitle | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const url = httpUrl(t.url);
  if (!url) return null;
  const language = text(t.language, 35); // BCP 47 tags are short
  const label = text(t.label, 100);
  return {
    url,
    ...(language ? { language } : {}),
    ...(label ? { label } : {}),
    ...(t.default === true ? { default: true } : {}),
  };
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return undefined;
  return /^https?:\/\//i.test(value) ? value : undefined;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Real frame sizes only. */
function resolutionOf(value: unknown): Resolution | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { width, height } = value as Record<string, unknown>;
  const valid = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_FRAME_DIMENSION;
  return valid(width) && valid(height) ? { width, height } : undefined;
}

/** A non-negative whole number, capped: counts from a page are advisory. */
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_REPORTED_COUNT, Math.round(value));
}
