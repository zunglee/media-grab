/**
 * Settings (PRD s47). Stored in `storage.local`, which is per-profile and never
 * synced - a naming template can contain a folder path, and download history is
 * private. Nothing here leaves the machine.
 *
 * The options page writes them (`saveSettings`) and tells the worker, which
 * reloads them (`loadSettings`). Both directions pass through `mergeSettings`,
 * so a value is checked the same way whether it came from storage or the form.
 */
import { browserApi } from '../browser/index.ts';
import { DEFAULT_TEMPLATE } from '../media/naming.ts';

const INTERFACE_MODES = ['simple', 'power'] as const;

/**
 * Only settings something actually reads. A switch that does nothing is a
 * promise the product does not keep, so features add their setting when they
 * ship. Stored keys from older versions are ignored by `mergeSettings`.
 */
export interface Settings {
  general: {
    autoScan: boolean;
    notifications: boolean;
    /** 'simple' hides codecs and manifests; 'power' shows everything. */
    mode: (typeof INTERFACE_MODES)[number];
  };
  downloads: {
    /** Whole downloads running at once. */
    concurrentDownloads: number;
    /** Parallel segment fetches within one HLS/DASH download. 0 = auto. */
    segmentConcurrency: number;
    retryCount: number;
    namingTemplate: string;
    baseFolder: string;
    siteFolders: boolean;
    dateFolders: boolean;
    askWhereToSave: boolean;
  };
  privacy: {
    keepHistory: boolean;
    historyLimit: number;
  };
  advanced: {
    debugLogging: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  general: {
    autoScan: true,
    notifications: true,
    mode: 'simple',
  },
  downloads: {
    concurrentDownloads: 3,
    segmentConcurrency: 0,
    retryCount: 3,
    namingTemplate: DEFAULT_TEMPLATE,
    baseFolder: 'MediaGrab',
    siteFolders: false,
    dateFolders: false,
    askWhereToSave: false,
  },
  privacy: {
    keepHistory: true,
    historyLimit: 200,
  },
  advanced: {
    debugLogging: false,
  },
};

/**
 * Fields that must be one of a fixed set, keyed `section.field`. A type check
 * alone would let `mode: 'banana'` through, and every reader would then have to
 * guess what it means.
 */
const ALLOWED_VALUES: Record<string, readonly unknown[]> = {
  'general.mode': INTERFACE_MODES,
};

const KEY = 'settings';

/**
 * Merge stored values over the defaults one level deep, so a settings file
 * written by an older version never leaves a field undefined, and anything
 * invalid falls back to its default.
 */
export function mergeSettings(stored: unknown): Settings {
  const merged = structuredClone(DEFAULT_SETTINGS);
  if (!isRecord(stored)) return merged;
  for (const section of Object.keys(merged) as Array<keyof Settings>) {
    const values = stored[section];
    if (!isRecord(values)) continue;
    Object.assign(merged[section], validFields(section, merged[section], values));
  }
  return clampSettings(merged);
}

/**
 * Stored data is untrusted: keep only the keys this version knows, holding the
 * type the default has and, for a field in ALLOWED_VALUES, an allowed value.
 */
function validFields(
  section: string,
  defaults: object,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!(key in defaults)) continue;
    if (typeof value !== typeof (defaults as Record<string, unknown>)[key]) continue;
    const allowed = ALLOWED_VALUES[`${section}.${key}`];
    if (allowed && !allowed.includes(value)) continue;
    out[key] = value;
  }
  return out;
}

function clampSettings(settings: Settings): Settings {
  settings.downloads.concurrentDownloads = clamp(settings.downloads.concurrentDownloads, 1, 8);
  settings.downloads.segmentConcurrency = clamp(settings.downloads.segmentConcurrency, 0, 8);
  settings.downloads.retryCount = clamp(settings.downloads.retryCount, 0, 10);
  settings.privacy.historyLimit = clamp(settings.privacy.historyLimit, 0, 2000);
  if (!settings.downloads.namingTemplate.trim())
    settings.downloads.namingTemplate = DEFAULT_TEMPLATE;
  return settings;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browserApi().storage.local.get<unknown>(KEY);
  return mergeSettings(stored);
}

/**
 * Stores the settings after the same checks a load applies, and returns what
 * was stored, so the form can show the value that will actually be used: 8 when
 * 20 was typed, the default when a number field was left empty.
 */
export async function saveSettings(settings: Settings): Promise<Settings> {
  const stored = mergeSettings(settings);
  await browserApi().storage.local.set(KEY, stored);
  return stored;
}
