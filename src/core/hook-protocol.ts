/**
 * The page hook's messages to the content script.
 *
 * The hook runs in the page's own JavaScript world (inject/page-hook.ts) and
 * the content script in its isolated one; `window.postMessage` is the only
 * wire between them. Both ends import this file, so the channel name and the
 * message shapes cannot drift apart.
 *
 * Anything on that wire could also have been posted by the page itself, so the
 * content script treats every message as a claim, not a fact: `parseHookMessage`
 * accepts only these shapes, and a reported URL is rebuilt into a candidate
 * like any other page input.
 *
 *   url       the page fetched something that looks like media (URL or type)
 *   mse       a MediaSource got a SourceBuffer: the player assembles media in JS
 *   keys      MediaKeys were attached to a media element: DRM is in use
 *   navigate  the page moved to another route: History API, hash route or
 *             Navigation API (replaceState does not: it tidies the address of
 *             the same page). `at` is when the address changed, on the
 *             document's own clock (`performance.now()`), so the new route
 *             starts there and not when the message happens to arrive. A page
 *             can post any `at`; the content script only believes one inside
 *             the route that is ending.
 *   hello     content script -> hook: "I am listening, replay what you saw"
 */
import { MAX_MIME_LENGTH, MAX_URL_LENGTH } from './limits.ts';

export const HOOK_CHANNEL = 'mediagrab:page-hook';

export type HookMessage =
  | { kind: 'url'; url: string; mimeType?: string }
  | { kind: 'mse' }
  | { kind: 'keys' }
  | { kind: 'navigate'; at?: number }
  | { kind: 'hello' };

export type HookEnvelope = HookMessage & { channel: typeof HOOK_CHANNEL };

export function envelope(message: HookMessage): HookEnvelope {
  return { channel: HOOK_CHANNEL, ...message };
}

/** The message, if `data` is exactly one of ours. Anything else is null. */
export function parseHookMessage(data: unknown): HookMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.channel !== HOOK_CHANNEL) return null;

  switch (record.kind) {
    case 'url': {
      const { url, mimeType } = record;
      if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return null;
      return typeof mimeType === 'string'
        ? { kind: 'url', url, mimeType: mimeType.slice(0, MAX_MIME_LENGTH) }
        : { kind: 'url', url };
    }
    case 'navigate': {
      const { at } = record;
      return typeof at === 'number' && Number.isFinite(at) && at >= 0
        ? { kind: 'navigate', at }
        : { kind: 'navigate' };
    }
    case 'mse':
    case 'keys':
    case 'hello':
      return { kind: record.kind };
    default:
      return null;
  }
}
