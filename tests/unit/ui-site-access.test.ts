/**
 * "Enable on this site" and "Allow on all sites" against a fake of each
 * build's permission model. The fake rejects a request that names an API
 * permission outside `optional_permissions`, as Firefox does for the whole
 * request (regression C1: every grant silently failed on Firefox).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __setBrowserApi } from '../../src/browser/index.ts';
import {
  hasAllSitesAccess,
  hasSiteAccess,
  requestAllSitesAccess,
  requestHostAccess,
  requestSiteAccess,
} from '../../src/permissions/site-access.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';

/** Chrome lists `webRequest` as optional; Firefox declares it as required. */
const BUILDS = {
  chrome: { optional: ['webRequest'], required: [] as string[] },
  firefox: { optional: [] as string[], required: ['webRequest'] },
};

function install(build: keyof typeof BUILDS, answer: 'grant' | 'decline' = 'grant') {
  const { optional, required } = BUILDS[build];
  const held = new Set<string>(required);
  const api = createFakeBrowserApi();
  api.runtime.optionalApiPermissions = () => optional;
  const request = vi.fn(async (origins: string[], apis: string[] = []) => {
    const notOptional = apis.filter((permission) => !optional.includes(permission));
    if (notOptional.length > 0) {
      throw new Error(`${notOptional.join(', ')} must be listed in optional_permissions`);
    }
    if (answer === 'decline') return false;
    for (const permission of [...origins, ...apis]) held.add(permission);
    return true;
  });
  const contains = vi.fn(async (origins: string[], apis: string[] = []) =>
    [...origins, ...apis].every((permission) => held.has(permission)),
  );
  api.permissions.request = request;
  api.permissions.contains = contains;
  __setBrowserApi(api);
  return { request, contains };
}

afterEach(() => __setBrowserApi(null));

describe('site access on each build', () => {
  it('Chrome: asks for the origin and webRequest together, and then holds both', async () => {
    const { request, contains } = install('chrome');
    expect(await hasSiteAccess('https://video.example/watch')).toBe(false);

    expect(await requestSiteAccess('https://video.example/watch')).toBe(true);
    expect(request).toHaveBeenCalledWith(['https://video.example/*'], ['webRequest']);
    expect(await hasSiteAccess('https://video.example/watch')).toBe(true);
    expect(contains).toHaveBeenLastCalledWith(['https://video.example/*'], ['webRequest']);
  });

  it('regression C1, Firefox: the grant succeeds because webRequest is not asked for', async () => {
    const { request, contains } = install('firefox');

    expect(await requestSiteAccess('https://video.example/watch')).toBe(true);
    expect(request).toHaveBeenCalledWith(['https://video.example/*'], []);
    expect(await hasSiteAccess('https://video.example/watch')).toBe(true);
    expect(contains).toHaveBeenLastCalledWith(['https://video.example/*'], []);
  });

  it('regression C1, Firefox: "Allow on all sites" succeeds too', async () => {
    install('firefox');
    expect(await requestAllSitesAccess()).toBe(true);
    expect(await hasAllSitesAccess()).toBe(true);
  });

  it('reaches permissions.request in the same tick as the click, so the gesture still counts', () => {
    const { request } = install('chrome');
    void requestSiteAccess('https://video.example/watch');
    expect(request).toHaveBeenCalledTimes(1);
    void requestAllSitesAccess();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reports a declined prompt as not granted', async () => {
    install('chrome', 'decline');
    expect(await requestSiteAccess('https://video.example/watch')).toBe(false);
    expect(await hasSiteAccess('https://video.example/watch')).toBe(false);
  });

  it('never asks for a page no extension may read', async () => {
    const { request } = install('chrome');
    expect(await requestSiteAccess('chrome://settings')).toBe(false);
    expect(await hasSiteAccess('file:///Users/me/video.mp4')).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('"Allow ‹host› and retry" (D18)', () => {
  it('asks for the refusing host on both schemes', async () => {
    const { request } = install('chrome');
    expect(await requestHostAccess('cdn.example')).toBe(true);
    expect(request).toHaveBeenCalledWith(['*://cdn.example/*'], ['webRequest']);
    expect(await requestHostAccess('[::1]')).toBe(true);
    expect(request).toHaveBeenLastCalledWith(['*://[::1]/*'], ['webRequest']);
  });

  it('accepts every hostname URL.hostname can produce (re-audit)', async () => {
    const { request } = install('chrome');
    for (const host of ['media_1.cdn.example', 'cdn.example.']) {
      expect(await requestHostAccess(host)).toBe(true);
      expect(request).toHaveBeenLastCalledWith([`*://${host}/*`], ['webRequest']);
    }
  });

  it('refuses anything that is not a hostname', async () => {
    const { request } = install('chrome');
    for (const host of ['*', '*.cdn.example', 'cdn.example/*', 'a b', '', 'https://cdn.example']) {
      expect(await requestHostAccess(host)).toBe(false);
    }
    expect(request).not.toHaveBeenCalled();
  });
});
