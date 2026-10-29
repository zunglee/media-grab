/**
 * Filename template engine (PRD s11, s35, s67).
 *
 * SECURITY: the output of this module is handed to `downloads.download({filename})`.
 * Page titles are attacker-controlled, so every value that reaches a path
 * segment is sanitized here, not at the call site. The rules:
 *   - path separators, `..`, control characters, NUL and lone surrogates are removed
 *   - leading dots are stripped (no hidden files, no `..`); trailing dots and
 *     spaces too (Windows silently drops them)
 *   - Windows-reserved device names (`CON`, `NUL.txt`, `COM1`...) are prefixed
 *   - a file name is sanitized as stem + extension, and only the stem is ever
 *     shortened: the extension always survives
 *   - lengths are capped in UTF-8 bytes (what filesystems count), cutting only
 *     at code-point boundaries, and the whole path is capped too
 * The browser also rejects absolute paths and traversal, but defence in depth
 * matters here because a bypass writes an arbitrary file to the user's disk.
 */
import type { MediaCandidate, MediaVariant } from '../core/types.ts';
import { registrableDomain } from './fingerprint.ts';
import { fileExtensionFor } from './format.ts';
import { qualityLabel, resolutionLabel } from './quality.ts';

export const DEFAULT_TEMPLATE = '{title} [{quality}].{ext}';

/**
 * Windows device names. Windows reserves them with any extension and ignoring
 * trailing spaces (`CON.mp4`, `nul .txt`), so a file called that is unopenable.
 * Includes COM0/LPT0 and the superscript-digit forms Windows also reserves.
 */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'conin$',
  'conout$',
  ...['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '\u00b9', '\u00b2', '\u00b3'].flatMap(
    (digit) => [`com${digit}`, `lpt${digit}`],
  ),
]);

/**
 * Characters illegal on at least one supported platform, plus path separators.
 * Written as a code-point test rather than a regex so that no control character
 * ever appears literally in this source file.
 */
const ILLEGAL_CHARS = new Set(['<', '>', ':', '"', '/', '|', '?', '*', String.fromCharCode(0x5c)]);

function stripIllegal(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    // A surrogate seen alone here is unpaired: not valid Unicode, not a valid name.
    const loneSurrogate = code >= 0xd800 && code <= 0xdfff;
    out += code < 0x20 || code === 0x7f || loneSurrogate || ILLEGAL_CHARS.has(ch) ? ' ' : ch;
  }
  return out;
}

/**
 * Longest file or folder name we write, in UTF-8 bytes, extension included.
 *
 * Filesystems cap one name at 255 bytes (ext4, APFS) or 255 UTF-16 units
 * (NTFS), but the tightest limit users really have is eCryptfs (encrypted
 * Linux home folders, some NAS shares): 143 bytes. While downloading, Chrome
 * appends ".crdownload" (11 bytes), and a name clash adds " (12)" (5 bytes):
 * 143 - 16 = 127. 120 keeps a small margin. Bytes, not characters, because a
 * character is 1-4 bytes: 120 characters of Japanese is 360 bytes.
 */
const MAX_NAME_BYTES = 120;

/**
 * Longest relative path handed to the browser, in UTF-16 code units (how
 * Windows counts). Windows refuses paths over 260 (MAX_PATH) unless long paths
 * are enabled, and the user's Downloads folder itself takes 30-60 of those.
 */
const MAX_PATH_UNITS = 200;

/** A stem is never cut below this, even to honour the path cap. */
const MIN_STEM_UNITS = 8;

/** Real extensions are short (mp4, webm, ttml); anything longer is not one. */
const MAX_EXTENSION_LENGTH = 8;

export interface NamingVariables {
  title?: string;
  creator?: string;
  domain?: string;
  date?: string;
  time?: string;
  quality?: string;
  resolution?: string;
  format?: string;
  codec?: string;
  language?: string;
  index?: string;
  ext?: string;
}

export interface FolderOptions {
  /** Base folder inside the browser's download directory. Empty = no subfolder. */
  baseFolder?: string;
  /** Downloads/MediaGrab/<domain>/... */
  siteFolders?: boolean;
  /** Downloads/MediaGrab/2026-09-07/... */
  dateFolders?: boolean;
}

/**
 * Make one path segment (a folder name) safe. Never returns an empty string,
 * never returns something that can escape its directory. For a file name use
 * `buildFilename`, which protects the extension; this treats the whole input
 * as one name and may shorten any part of it.
 */
export function sanitizeSegment(input: string, fallback = 'download'): string {
  const value = trimTrailing(truncate(escapeReserved(cleanName(input)), MAX_NAME_BYTES));
  return value || fallback;
}

/**
 * Sanitize a file name as stem + extension. Only the stem is shortened, to fit
 * `MAX_NAME_BYTES` for the whole name and `maxUnits` UTF-16 units (the room the
 * path cap leaves), so `.mp4` is never lost to a long title.
 */
function sanitizeFilename(
  stem: string,
  extension: string,
  fallbackStem: string,
  maxUnits = MAX_PATH_UNITS,
): string {
  const suffix = `.${sanitizeExtension(extension)}`;
  const byteBudget = MAX_NAME_BYTES - utf8Length(suffix);
  const unitBudget = Math.max(MIN_STEM_UNITS, maxUnits - suffix.length);
  const base = escapeReserved(cleanName(stem) || cleanName(fallbackStem) || 'media');
  const fitted = trimTrailing(truncate(base, byteBudget, unitBudget));
  return `${fitted || 'media'}${suffix}`;
}

/** Illegal characters out, whitespace collapsed, no leading or trailing dots. */
function cleanName(input: string): string {
  let value = stripIllegal(input.normalize('NFC'));
  value = trimTrailing(value.replace(/\s+/g, ' ').trim());
  // Remove every dot run that begins a word. Path separators are already gone,
  // so `..` cannot traverse; this also stops hidden files (`.bashrc`) and any
  // `..` surviving into the name at all.
  value = value
    .replace(/(^|\s)\.+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return trimTrailing(value);
}

/** Windows drops trailing dots and spaces, so `name.` and `name` would collide. */
function trimTrailing(value: string): string {
  return value.replace(/[. ]+$/, '');
}

/** `CON.mp4` -> `_CON.mp4`: Windows reserves the device name before the first dot. */
function escapeReserved(name: string): string {
  const device = (name.split('.')[0] ?? '').trimEnd().toLowerCase();
  return RESERVED_NAMES.has(device) ? `_${name}` : name;
}

function sanitizeExtension(extension: string): string {
  const cleaned = extension.replace(/[^a-z0-9]/gi, '').slice(0, MAX_EXTENSION_LENGTH);
  return cleaned || 'bin';
}

/**
 * The longest prefix of `text` within both budgets, cut at a code-point
 * boundary so a surrogate pair (an emoji, a rare CJK character) is never split.
 */
function truncate(text: string, maxBytes: number, maxUnits = Number.POSITIVE_INFINITY): string {
  let bytes = 0;
  let units = 0;
  for (const ch of text) {
    const size = utf8Length(ch);
    if (bytes + size > maxBytes || units + ch.length > maxUnits) break;
    bytes += size;
    units += ch.length;
  }
  return text.slice(0, units);
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Expand `{var}` placeholders. Unknown placeholders are dropped, not left raw. */
export function renderTemplate(template: string, variables: NamingVariables): string {
  const expanded = template.replace(/\{([a-z]+)\}/gi, (_whole, name: string) => {
    const value = variables[name.toLowerCase() as keyof NamingVariables];
    return value === undefined ? '' : String(value);
  });

  // Tidy the gaps a missing variable leaves behind: " []", " - - ", "  ".
  return expanded
    .replace(/\[\s*\]/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s*-\s*-\s*/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+\./g, '.')
    .trim();
}

export interface BuildFilenameInput {
  candidate: MediaCandidate;
  variant?: MediaVariant;
  template?: string;
  folders?: FolderOptions;
  /** 1-based position when downloading a playlist or a batch. */
  index?: number;
  /** Overrides the container extension (audio extraction, subtitle sidecar). */
  extension?: string;
  now?: Date;
}

/**
 * Full relative path handed to the downloads API, e.g.
 * `MediaGrab/vimeo.com/How to Build a Startup [1080p].mp4`.
 */
export function buildFilename(input: BuildFilenameInput): string {
  const { candidate, variant } = input;
  const now = input.now ?? new Date();
  const template = input.template?.trim() || DEFAULT_TEMPLATE;

  const extension = sanitizeExtension(
    input.extension ?? fileExtensionFor(candidate.format, candidate.kind, candidate.mimeType),
  );
  const resolution = variant?.resolution ?? candidate.resolution;
  const domain = hostOf(candidate.pageUrl) ?? hostOf(candidate.url);

  const variables: NamingVariables = {
    title: titleFor(candidate),
    domain: domain ?? 'unknown',
    date: isoDate(now),
    time: isoTime(now),
    ext: extension,
    format: candidate.format === 'unknown' ? extension : candidate.format,
    ...(variant ? { quality: qualityLabel(variant) } : qualityFromCandidate(candidate)),
    ...(resolution ? { resolution: `${resolution.width}x${resolution.height}` } : {}),
    ...(candidate.codecs?.[0] ? { codec: candidate.codecs[0] } : {}),
    ...(candidate.language ? { language: candidate.language } : {}),
    ...(input.index !== undefined ? { index: String(input.index).padStart(2, '0') } : {}),
  };

  // Folders are never shortened, so the file stays where the user's rules put
  // it; the name gives up whatever room the folders take.
  const folders = buildFolders(input.folders, variables, now);
  const prefix = folders.map((folder) => `${folder}/`).join('');
  const maxUnits = MAX_PATH_UNITS - prefix.length;

  // A long title is shortened before rendering, so the rest of the template
  // (" [1080p]") survives; the stem cap below is the safety net.
  const suffix = `.${extension}`;
  const fixed = stemOf(renderTemplate(template, { ...variables, title: '' }), suffix);
  const title = variables.title ?? '';
  variables.title = trimTrailing(
    truncate(
      title,
      MAX_NAME_BYTES - utf8Length(`${fixed} ${suffix}`),
      Math.max(MIN_STEM_UNITS, maxUnits - fixed.length - 1 - suffix.length),
    ),
  );

  const stem = stemOf(renderTemplate(template, variables), suffix);
  return `${prefix}${sanitizeFilename(stem, extension, 'media', maxUnits)}`;
}

/** The rendered name without its extension; a template that omits {ext} still gets one. */
function stemOf(rendered: string, suffix: string): string {
  return rendered.toLowerCase().endsWith(suffix.toLowerCase())
    ? rendered.slice(0, -suffix.length)
    : rendered;
}

/**
 * The media's own title verbatim when it has one (an element, link or JSON-LD
 * named it); otherwise the page title minus the site name the CMS appended.
 */
function titleFor(candidate: MediaCandidate): string {
  if (candidate.title) return candidate.title;
  const page = candidate.pageTitle ? cleanTitle(candidate.pageTitle, candidate.pageUrl) : '';
  return page || hostOf(candidate.pageUrl) || 'media';
}

function qualityFromCandidate(candidate: MediaCandidate): { quality?: string } {
  if (candidate.resolution)
    return { quality: resolutionLabel(candidate.resolution, candidate.fps) };
  if (candidate.kind === 'audio') return { quality: 'audio' };
  return {};
}

function buildFolders(
  options: FolderOptions | undefined,
  variables: NamingVariables,
  now: Date,
): string[] {
  if (!options) return [];
  const folders: string[] = [];
  const base = options.baseFolder?.trim();
  if (base) {
    for (const part of base.split('/')) {
      const safe = sanitizeSegment(part, '');
      if (safe) folders.push(safe);
    }
  }
  if (options.siteFolders && variables.domain)
    folders.push(sanitizeSegment(variables.domain, 'site'));
  if (options.dateFolders) folders.push(isoDate(now));
  return folders;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isoTime(date: Date): string {
  return `${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** What sits between a title and the site name a CMS appends. */
const SITE_SEPARATORS = [' | ', ' - ', ' \u2013 ', ' \u2014 ', ' :: ', ' \u00b7 '];

/**
 * Clean up a page title for use as a media title: drop the site name that most
 * CMSs append ("How to Cook Rice | Tasty" on tasty.co -> "How to Cook Rice").
 *
 * `site` is the page URL, its hostname, or the site's name. A trailing
 * " | X", " - X", " – X", " — X", " :: X" or " · X" is removed only when X is
 * that site, compared ignoring case, spaces and punctuation: the name itself,
 * or the domain ("Tasty.co") or its main label ("YouTube" on youtube.com,
 * "BBC" on bbc.co.uk). Anything else is part of the title - "Taylor Swift -
 * Anti-Hero" keeps its song name - and without `site` the title is only tidied.
 */
export function cleanTitle(pageTitle: string, site?: string): string {
  let title = pageTitle.replace(/\s+/g, ' ').trim();
  const names = siteNames(site);
  if (names.size === 0) return title;

  for (;;) {
    const cut = lastSeparator(title);
    if (!cut) break;
    const head = title.slice(0, cut.index).trim();
    const tail = comparable(title.slice(cut.index + cut.separator.length));
    if (!head || !names.has(tail)) break;
    title = head;
  }
  return title;
}

function lastSeparator(title: string): { index: number; separator: string } | undefined {
  let best: { index: number; separator: string } | undefined;
  for (const separator of SITE_SEPARATORS) {
    const index = title.lastIndexOf(separator);
    if (index > 0 && (!best || index > best.index)) best = { index, separator };
  }
  return best;
}

/** Every spelling of the site a title might end with, in `comparable` form. */
function siteNames(site: string | undefined): Set<string> {
  const names = new Set<string>();
  const value = site?.trim();
  if (!value) return names;

  const host = hostOfSite(value);
  if (host) {
    const domain = registrableDomain(host);
    names.add(comparable(domain));
    names.add(comparable(domain.split('.')[0] ?? ''));
  } else {
    names.add(comparable(value));
  }
  names.delete('');
  return names;
}

/** The hostname when `site` is a URL or a bare hostname; undefined when it is a name. */
function hostOfSite(site: string): string | undefined {
  if (site.includes('://')) return hostOf(site);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(site) ? site : undefined;
}

/** Lowercase letters and digits only: "You Tube!" and "youtube" compare equal. */
function comparable(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
