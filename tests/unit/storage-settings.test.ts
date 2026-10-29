/**
 * Settings validation on load and save, against an in-memory storage.local.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserApi } from '../../src/browser/api.ts';
import { __setBrowserApi } from '../../src/browser/index.ts';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  mergeSettings,
  type Settings,
  saveSettings,
} from '../../src/storage/settings.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';

let api: BrowserApi;

beforeEach(() => {
  api = createFakeBrowserApi();
  __setBrowserApi(api);
});

afterEach(() => __setBrowserApi(null));

function withDownloads(patch: Record<string, unknown>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    downloads: { ...DEFAULT_SETTINGS.downloads, ...patch },
  } as Settings;
}

describe('settings with a fixed set of values', () => {
  it('regression CD10: an unknown interface mode falls back to the default', () => {
    expect(mergeSettings({ general: { mode: 'banana' } }).general.mode).toBe('simple');
    expect(mergeSettings({ general: { mode: 'power' } }).general.mode).toBe('power');
  });

  it('regression CD10: a stored unknown mode loads as the default', async () => {
    await api.storage.local.set('settings', { general: { mode: 'banana', autoScan: false } });
    const loaded = await loadSettings();
    expect(loaded.general.mode).toBe('simple');
    expect(loaded.general.autoScan).toBe(false);
  });
});

describe('saving settings', () => {
  it('regression C15: returns the value that was stored, so the form can show it', async () => {
    const saved = await saveSettings(withDownloads({ concurrentDownloads: 20 }));
    expect(saved.downloads.concurrentDownloads).toBe(8);
    expect((await loadSettings()).downloads.concurrentDownloads).toBe(8);
  });

  it('regression C15: an emptied number field is saved, and shown, as the default', async () => {
    // What a cleared <input type="number"> binds to.
    const saved = await saveSettings(withDownloads({ retryCount: null, namingTemplate: '' }));
    expect(saved.downloads.retryCount).toBe(DEFAULT_SETTINGS.downloads.retryCount);
    expect(saved.downloads.namingTemplate).toBe(DEFAULT_SETTINGS.downloads.namingTemplate);
  });

  it('does not change the object it was given', async () => {
    const input = withDownloads({ concurrentDownloads: 20 });
    await saveSettings(input);
    expect(input.downloads.concurrentDownloads).toBe(20);
  });
});
