import type { BrowserApi } from './api.ts';
import { createWebExtApi } from './webext.ts';

let instance: BrowserApi | null = null;

/**
 * Lazily built so that importing any module in a unit test does not require a
 * WebExtension namespace to exist.
 */
export function browserApi(): BrowserApi {
  if (!instance) instance = createWebExtApi();
  return instance;
}

/** Test seam. Only tests and the dev harness call this. */
export function __setBrowserApi(api: BrowserApi | null): void {
  instance = api;
}

export type * from './api.ts';
