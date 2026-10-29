/**
 * Chooses where segment assembly runs, and hides the difference from the
 * download engine.
 *
 *   Chrome  - service worker has no createObjectURL -> offscreen document
 *   Firefox - background is an event page with a DOM -> run in place
 *
 * If neither path is available the engine gets a clear error instead of a
 * silent failure, which is the difference between "MediaGrab told me it cannot
 * do this" and "MediaGrab is broken".
 */
import { browserApi } from '../browser/index.ts';
import { ErrorCode, MediaGrabError } from '../core/errors.ts';
import { debugLoggingEnabled } from '../core/log.ts';
import type { SegmentPlan } from '../manifests/segment-plan.ts';
import {
  fromErrorResponse,
  isOffscreenProgress,
  type OffscreenRequest,
  type OffscreenResponse,
} from '../offscreen/protocol.ts';
import { assembleToObjectUrl } from './assembler.ts';

const OFFSCREEN_PATH = 'offscreen.html';
const OFFSCREEN_JUSTIFICATION =
  'Assemble downloaded media segments into a file the browser can save.';

export interface AssemblyRequest {
  taskId: string;
  plan: SegmentPlan;
  mimeType: string;
  concurrency: number;
  retries: number;
  signal: AbortSignal;
  onProgress?: (receivedBytes: number, segmentsDone: number, segmentsTotal: number) => void;
}

export interface AssemblyResult {
  objectUrl: string;
  totalBytes: number;
}

export async function assemble(request: AssemblyRequest): Promise<AssemblyResult> {
  // An abort listener added to a signal that has already fired never runs, so
  // a stop that came first would never reach the document: refuse here.
  if (request.signal.aborted) throw new MediaGrabError(ErrorCode.CANCELLED, 'Cancelled');
  if (typeof URL.createObjectURL === 'function') {
    // Firefox event page, or any future context with a DOM.
    return assembleToObjectUrl(request);
  }

  const api = browserApi();
  if (!api.offscreen.isSupported()) {
    throw new MediaGrabError(
      ErrorCode.BROWSER_PERMISSION,
      'This browser cannot assemble streamed downloads (no offscreen document support).',
    );
  }
  await api.offscreen.ensureDocument(OFFSCREEN_PATH, OFFSCREEN_JUSTIFICATION);
  // Stopped while the document was being made: from here to the send below
  // nothing awaits, so a later stop reaches the listener and cancels there.
  if (request.signal.aborted) throw new MediaGrabError(ErrorCode.CANCELLED, 'Cancelled');

  const stopListening = api.runtime.onMessage((message) => {
    if (isOffscreenProgress(message) && message.taskId === request.taskId) {
      request.onProgress?.(message.receivedBytes, message.segmentsDone, message.segmentsTotal);
    }
    return undefined;
  });
  const onAbort = () => {
    void send({ target: 'offscreen', type: 'CANCEL', taskId: request.taskId });
  };
  request.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await send({
      target: 'offscreen',
      type: 'ASSEMBLE',
      taskId: request.taskId,
      plan: request.plan,
      mimeType: request.mimeType,
      concurrency: request.concurrency,
      retries: request.retries,
      debugLogging: debugLoggingEnabled(),
    });
    // Rebuilt with every field the document sent, the refusing host included.
    if (response?.ok !== true) throw fromErrorResponse(response);
    return { objectUrl: response.objectUrl, totalBytes: response.totalBytes };
  } finally {
    stopListening();
    request.signal.removeEventListener('abort', onAbort);
  }
}

/** Free the blob once the browser has taken the bytes. */
export async function releaseObjectUrl(objectUrl: string): Promise<void> {
  if (!objectUrl.startsWith('blob:')) return;
  if (typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(objectUrl);
    return;
  }
  if (browserApi().offscreen.isSupported()) {
    await send({ target: 'offscreen', type: 'REVOKE', objectUrl });
  }
}

/**
 * A request the offscreen document must answer. When it cannot be delivered or
 * the document goes away first, the browser's own reason is kept as the detail,
 * so "did not respond" always says why.
 */
async function send(request: OffscreenRequest): Promise<OffscreenResponse | undefined> {
  try {
    return (await browserApi().runtime.request(request)) as OffscreenResponse | undefined;
  } catch (err) {
    throw new MediaGrabError(ErrorCode.INTERNAL, 'The offscreen document did not respond', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
