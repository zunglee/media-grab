/**
 * Adapter registry.
 *
 * Deliberately simple: a list of site adapters, host-suffix match, first match
 * wins, with the generic adapter as the fallback that always applies. The value
 * of the adapter architecture is that the core engine never learns a site's
 * name, not that the lookup is clever.
 *
 * NOT IMPLEMENTED (and not pretended to be): remote, signed adapter delivery
 * (PRD s18). Shipping code fetched at runtime needs a signing key, a
 * verification path and a review process before it is anything but a
 * self-inflicted supply-chain hole. Until that exists, adapters are bundled and
 * reviewed. See ARCHITECTURE.md "Adapter distribution".
 */
import { genericAdapter } from './sites/generic.ts';
import type { SiteAdapter } from './types.ts';

/** Site-specific adapters, checked in order. The generic one is not in here. */
const siteAdapters: SiteAdapter[] = [];

/**
 * The extension point for bundled site adapters (ARCHITECTURE.md D7). Nothing
 * registers one yet; it is kept so adding the first does not touch the engine.
 * @public
 */
export function registerAdapter(adapter: SiteAdapter): void {
  const existing = siteAdapters.findIndex((entry) => entry.id === adapter.id);
  if (existing >= 0) siteAdapters.splice(existing, 1, adapter);
  else siteAdapters.push(adapter);
}

/** Never returns undefined in practice: the generic adapter is the fallback. */
export function adapterFor(url: string): SiteAdapter {
  const match = siteAdapters.find((adapter) => {
    try {
      return adapter.matches(url);
    } catch {
      return false;
    }
  });
  return match ?? genericAdapter;
}
