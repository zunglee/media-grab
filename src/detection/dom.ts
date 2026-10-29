/**
 * DOM detection. Runs inside the content script (ISOLATED world), so it can
 * read the page's DOM but not its JavaScript objects - the MAIN-world hook in
 * inject/page-hook.ts covers what the DOM cannot see.
 *
 * Output is a list of claims (`ReportedCandidate`): a URL, its kind, where it
 * was found and what the page says about it. The worker turns claims into
 * candidates (detection/candidate.ts); nothing here decides protocol, score or
 * identity.
 *
 * Rules that are easy to get wrong:
 *  - URLs resolve against `document.baseURI`, not the page URL: with
 *    `<base href="/">` (every Angular app) the two differ, and the browser
 *    fetches from the base.
 *  - Each `<source>` keeps its own `type`; a player offering WebM and MP4 is
 *    two files, not two WebMs.
 *  - `blob:` and `data:` URLs are never claims: the browser cannot download a
 *    page's object URL. A `blob:` src still counts as a MediaSource signal:
 *    nearly always it is one, and the page hook, which could tell, may have
 *    arrived after the player made it (injected right after a grant). A video
 *    built from a finished Blob is diagnosed "streams in pieces" as a result;
 *    it cannot be downloaded either way.
 *  - Every read of a page-owned object is wrapped: a page can define a getter
 *    that throws on `video.currentSrc`, and one throw must not end the scan.
 */
import {
  MAX_DOM_DATA_ELEMENTS,
  MAX_DOM_LINKS,
  MAX_JSON_LD_CHARS,
  MAX_JSON_LD_DEPTH,
  MAX_TITLE_LENGTH,
} from '../core/limits.ts';
import type { ReportedCandidate, ReportedSource, ReportedSubtitle } from '../core/messages.ts';
import type { MediaKind, PageSignals } from '../core/types.ts';
import { classifyMediaUrl } from '../media/format.ts';
import { choosePagePoster } from '../media/poster.ts';

export interface DomScanResult {
  found: ReportedCandidate[];
  signals: PageSignals;
  /**
   * A picture that represents the page: the poster of a player, og:image,
   * twitter:image. Used to give network-found manifests something to show
   * (media/poster.ts).
   */
  pagePoster?: string;
}

/** Attributes that lazy-loading players stash real URLs in. */
const URL_ATTRIBUTES = [
  'src',
  'data-src',
  'data-video-src',
  'data-mp4',
  'data-hls',
  'data-dash',
  'data-url',
  'data-source',
];

/** Every element carrying one of the data-* attributes above. */
const LAZY_SELECTOR = URL_ATTRIBUTES.filter((name) => name.startsWith('data-'))
  .map((name) => `[${name}]`)
  .join(', ');

const META_MEDIA = [
  { selector: 'meta[property="og:video"]', kind: 'video' },
  { selector: 'meta[property="og:video:url"]', kind: 'video' },
  { selector: 'meta[property="og:video:secure_url"]', kind: 'video' },
  { selector: 'meta[property="og:audio"]', kind: 'audio' },
  { selector: 'meta[name="twitter:player:stream"]', kind: 'video' },
] as const;

export function scanDom(doc: Document = document): DomScanResult {
  const base = safe(() => doc.baseURI) ?? '';
  const found: ReportedCandidate[] = [];
  const signals: PageSignals = {
    hasMediaSource: false,
    hasMediaKeys: false,
    mediaElements: 0,
    playerFrames: countPlayerFrames(doc),
  };
  const posters: Array<string | undefined> = [];

  const mediaElements = Array.from(doc.querySelectorAll('video, audio')) as HTMLMediaElement[];
  signals.mediaElements = mediaElements.length;
  for (const media of mediaElements) {
    const element = readMediaElement(media, base);
    found.push(...element.found);
    posters.push(element.poster);
    signals.hasMediaSource ||= element.usesMediaSource;
    signals.hasMediaKeys ||= element.hasMediaKeys;
  }

  found.push(...scanMetadata(doc, base), ...scanLinksAndAttributes(doc, base));

  const pagePoster = choosePagePoster([
    // A player's own poster first: it is the frame the player is showing.
    ...posters,
    metaUrl(doc, 'meta[property="og:image"]', base),
    metaUrl(doc, 'meta[property="og:image:secure_url"]', base),
    metaUrl(doc, 'meta[name="twitter:image"]', base),
  ]);

  return { found, signals, ...(pagePoster ? { pagePoster } : {}) };
}

interface MediaElementReading {
  found: ReportedCandidate[];
  poster?: string;
  usesMediaSource: boolean;
  hasMediaKeys: boolean;
}

function readMediaElement(media: HTMLMediaElement, base: string): MediaElementReading {
  const kind: MediaKind = media.tagName.toLowerCase() === 'audio' ? 'audio' : 'video';
  const video = kind === 'video' ? (media as HTMLVideoElement) : undefined;
  const poster = video
    ? absolute(
        safe(() => video.getAttribute('poster')),
        base,
      )
    : undefined;
  const duration = positive(safe(() => media.duration));
  const width = positive(safe(() => video?.videoWidth));
  const height = positive(safe(() => video?.videoHeight));
  const title = ownTitle(media);
  const subtitles = readTextTracks(media, base);
  const describe = {
    ...(duration !== undefined ? { duration } : {}),
    ...(width && height ? { resolution: { width, height } } : {}),
    ...(poster ? { posterUrl: poster } : {}),
    ...(title ? { title } : {}),
    ...(subtitles.length > 0 ? { subtitles } : {}),
  };

  // <source> children first, each with its own type; then the element's own
  // attributes and currentSrc, which carry no type - so a URL already found
  // on a <source> keeps that type rather than being listed again without it.
  const urls = new Map<string, string | undefined>();
  for (const source of Array.from(media.querySelectorAll('source'))) {
    const type = safe(() => source.getAttribute('type')) ?? undefined;
    for (const url of attributeUrls(source, base)) if (!urls.has(url)) urls.set(url, type);
  }
  const currentSrc = safe(() => media.currentSrc);
  for (const url of [...attributeUrls(media, base), ...(currentSrc ? [currentSrc] : [])]) {
    if (!urls.has(url)) urls.set(url, undefined);
  }

  // srcObject is a MediaSource or a MediaStream: there is no URL to fetch.
  const usesMediaSource =
    safe(() => media.srcObject !== null) === true ||
    [...urls.keys()].some((url) => url.startsWith('blob:'));
  const found: ReportedCandidate[] = [];
  for (const [url, mimeType] of urls) {
    if (!isHttp(url)) continue;
    found.push({
      url,
      kind,
      source: 'dom-element',
      ...(mimeType ? { mimeType } : {}),
      ...describe,
    });
  }

  return {
    found,
    ...(poster ? { poster } : {}),
    usesMediaSource,
    hasMediaKeys: safe(() => media.mediaKeys != null) === true,
  };
}

/** og:video and friends, and JSON-LD VideoObject / AudioObject. */
function scanMetadata(doc: Document, base: string): ReportedCandidate[] {
  const out: ReportedCandidate[] = [];
  for (const { selector, kind } of META_MEDIA) {
    for (const meta of Array.from(doc.querySelectorAll(selector))) {
      const url = absolute(
        safe(() => meta.getAttribute('content')),
        base,
      );
      if (url) out.push({ url, kind, source: 'dom-attribute' });
    }
  }

  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    const text = safe(() => script.textContent);
    if (!text || text.length > MAX_JSON_LD_CHARS) continue;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    for (const node of flattenJsonLd(data)) {
      const type = node['@type'];
      if (type !== 'VideoObject' && type !== 'AudioObject') continue;
      const url = absolute(stringOrUndefined(node.contentUrl), base);
      if (!url) continue;
      const title = stringOrUndefined(node.name)?.slice(0, MAX_TITLE_LENGTH);
      const posterUrl = absolute(stringOrUndefined(node.thumbnailUrl), base);
      out.push({
        url,
        kind: type === 'AudioObject' ? 'audio' : 'video',
        source: 'dom-attribute',
        ...(title ? { title } : {}),
        ...(posterUrl ? { posterUrl } : {}),
      });
    }
  }
  return out;
}

/** Links and lazy-load attributes that point straight at a media file. */
function scanLinksAndAttributes(doc: Document, base: string): ReportedCandidate[] {
  const out: ReportedCandidate[] = [];
  const add = (raw: string | null | undefined, source: ReportedSource, title?: string) => {
    const url = absolute(raw, base);
    const media = url ? classifyMediaUrl(url) : null;
    if (!url || !media || media.isSegment) return;
    out.push({ url, kind: media.kind, source, ...(title ? { title } : {}) });
  };

  for (const anchor of Array.from(doc.querySelectorAll('a[href]')).slice(0, MAX_DOM_LINKS)) {
    const text = safe(() => anchor.textContent?.trim().slice(0, MAX_TITLE_LENGTH)) || undefined;
    add(
      safe(() => anchor.getAttribute('href')),
      'dom-attribute',
      text,
    );
  }

  const lazy = doc.querySelectorAll(LAZY_SELECTOR);
  for (const element of Array.from(lazy).slice(0, MAX_DOM_DATA_ELEMENTS)) {
    // <video>/<audio> and their <source>s were read above, with more context.
    if (element.closest('video, audio')) continue;
    for (const attribute of URL_ATTRIBUTES)
      add(
        safe(() => element.getAttribute(attribute)),
        'dom-attribute',
      );
  }
  return out;
}

function readTextTracks(media: HTMLMediaElement, base: string): ReportedSubtitle[] {
  const out: ReportedSubtitle[] = [];
  for (const track of Array.from(media.querySelectorAll('track'))) {
    const url = absolute(
      safe(() => track.getAttribute('src')),
      base,
    );
    if (!url) continue;
    const language = safe(() => track.getAttribute('srclang')) || undefined;
    const label = safe(() => track.getAttribute('label')) || undefined;
    out.push({
      url,
      ...(language ? { language } : {}),
      ...(label ? { label } : {}),
      ...(safe(() => track.hasAttribute('default')) === true ? { default: true } : {}),
    });
  }
  return out;
}

/**
 * Cross-origin iframes that look like embedded players. Diagnosis uses this to
 * say "the video is in an embedded frame", so ad and widget frames must not
 * count. Player embeds (YouTube, Vimeo, JW, Brightcove...) ask for fullscreen
 * or autoplay or protected media; ads and social widgets almost never do.
 */
function countPlayerFrames(doc: Document): number {
  let count = 0;
  for (const frame of Array.from(doc.querySelectorAll('iframe'))) {
    const allow = (safe(() => frame.getAttribute('allow')) ?? '').toLowerCase();
    const playerLike =
      safe(() => frame.hasAttribute('allowfullscreen')) === true ||
      /fullscreen|autoplay|encrypted-media|picture-in-picture/.test(allow);
    if (playerLike && isCrossOrigin(frame)) count += 1;
  }
  return count;
}

function isCrossOrigin(frame: HTMLIFrameElement): boolean {
  try {
    // Reading contentDocument throws (or returns null) across origins.
    return frame.contentDocument === null;
  } catch {
    return true;
  }
}

function attributeUrls(element: Element, base: string): string[] {
  const urls: string[] = [];
  for (const attribute of URL_ATTRIBUTES) {
    const url = absolute(
      safe(() => element.getAttribute(attribute)),
      base,
    );
    if (url) urls.push(url);
  }
  return urls;
}

/** A element's own name for itself - never the page title, which the report carries once. */
function ownTitle(media: HTMLMediaElement): string | undefined {
  for (const attribute of ['title', 'aria-label', 'data-title']) {
    const value = safe(() => media.getAttribute(attribute))?.trim();
    if (value) return value.slice(0, MAX_TITLE_LENGTH);
  }
  return undefined;
}

function metaUrl(doc: Document, selector: string, base: string): string | undefined {
  return absolute(
    safe(() => doc.querySelector(selector)?.getAttribute('content')),
    base,
  );
}

function flattenJsonLd(data: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > MAX_JSON_LD_DEPTH) return [];
  if (Array.isArray(data)) return data.flatMap((item) => flattenJsonLd(item, depth + 1));
  if (typeof data !== 'object' || data === null) return [];
  const node = data as Record<string, unknown>;
  const nested = Object.values(node).flatMap((value) =>
    typeof value === 'object' && value !== null ? flattenJsonLd(value, depth + 1) : [],
  );
  return [node, ...nested];
}

/** Resolve against the document's base URL; undefined for empty or unparseable input. */
function absolute(url: string | null | undefined, base: string): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    return new URL(url.trim(), base || undefined).toString();
  } catch {
    return undefined;
  }
}

function isHttp(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://');
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Page-owned getters can throw; never let one abort a whole scan. */
function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
