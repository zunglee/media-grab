/**
 * Offscreen document entry point (Chrome only).
 *
 * Exists for one reason: `URL.createObjectURL` is unavailable in an MV3 service
 * worker, and a segmented download has to become a Blob before the downloads
 * API can save it. Doing the fetching here as well means the media bytes never
 * cross a message boundary - only the resulting blob: URL does.
 *
 * What this document holds: while a download is fetching, its segments as
 * Blobs; after, one Blob composed of them (not a second copy, see
 * downloads/segment-fetcher.ts), until the worker revokes its URL. A CANCEL
 * aborts the fetch, and a cancelled or failed assembly creates no URL and keeps
 * nothing. Errors cross back as plain fields (protocol.ts `toErrorResponse`).
 *
 * This document has no page content, no user interaction and no host page.
 * Only messages addressed to it (`target: 'offscreen'`) are handled. Runtime
 * messages come only from this extension's own scripts, never from a web page.
 */
import { browserApi } from '../browser/index.ts';
import { setDebugLogging } from '../core/log.ts';
import { assembleToObjectUrl } from '../downloads/assembler.ts';
import {
  isOffscreenRequest,
  type OffscreenProgress,
  type OffscreenRequest,
  type OffscreenResponse,
  toErrorResponse,
} from './protocol.ts';

const inFlight = new Map<string, AbortController>();

browserApi().runtime.onMessage((message) => {
  if (!isOffscreenRequest(message)) return undefined;
  return handle(message).catch(toErrorResponse);
});

async function handle(request: OffscreenRequest): Promise<OffscreenResponse | { ok: true }> {
  switch (request.type) {
    case 'ASSEMBLE': {
      setDebugLogging(request.debugLogging);
      // A worker killed mid-download may have left this task's earlier attempt
      // running here; the new attempt replaces it.
      inFlight.get(request.taskId)?.abort();
      const controller = new AbortController();
      inFlight.set(request.taskId, controller);
      try {
        const result = await assembleToObjectUrl({
          plan: request.plan,
          mimeType: request.mimeType,
          concurrency: request.concurrency,
          retries: request.retries,
          signal: controller.signal,
          onProgress: (receivedBytes, segmentsDone, segmentsTotal) => {
            const progress: OffscreenProgress = {
              target: 'background',
              type: 'ASSEMBLE_PROGRESS',
              taskId: request.taskId,
              receivedBytes,
              segmentsDone,
              segmentsTotal,
            };
            void browserApi().runtime.sendMessage(progress);
          },
        });
        return { ok: true, objectUrl: result.objectUrl, totalBytes: result.totalBytes };
      } finally {
        // Only this attempt's own entry: a newer attempt may have replaced it.
        if (inFlight.get(request.taskId) === controller) inFlight.delete(request.taskId);
      }
    }

    case 'CANCEL': {
      inFlight.get(request.taskId)?.abort();
      inFlight.delete(request.taskId);
      return { ok: true };
    }

    case 'REVOKE': {
      // The blob is only freed when its object URL is revoked; a leak here is a
      // leak of the entire downloaded file.
      try {
        URL.revokeObjectURL(request.objectUrl);
      } catch {
        // Already revoked; nothing to do.
      }
      return { ok: true };
    }

    default:
      return { ok: false, code: 'INTERNAL', message: 'Unknown offscreen request' };
  }
}
