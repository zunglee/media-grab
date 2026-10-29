/**
 * Messages between the background worker and the offscreen document.
 *
 * Every message carries `target` so the background's own onMessage listener can
 * ignore traffic addressed to the offscreen document and vice versa - they share
 * one runtime message bus.
 */
import { ErrorCode, MediaGrabError, toMediaGrabError } from '../core/errors.ts';
import type { SegmentPlan } from '../manifests/segment-plan.ts';

export interface OffscreenAssembleRequest {
  target: 'offscreen';
  type: 'ASSEMBLE';
  taskId: string;
  plan: SegmentPlan;
  mimeType: string;
  concurrency: number;
  retries: number;
  /** The worker's debug switch; this document has its own logger to set. */
  debugLogging: boolean;
}

export interface OffscreenCancelRequest {
  target: 'offscreen';
  type: 'CANCEL';
  taskId: string;
}

export interface OffscreenRevokeRequest {
  target: 'offscreen';
  type: 'REVOKE';
  objectUrl: string;
}

export type OffscreenRequest =
  | OffscreenAssembleRequest
  | OffscreenCancelRequest
  | OffscreenRevokeRequest;

export interface OffscreenProgress {
  target: 'background';
  type: 'ASSEMBLE_PROGRESS';
  taskId: string;
  receivedBytes: number;
  segmentsDone: number;
  segmentsTotal: number;
}

export interface OffscreenAssembleResponse {
  ok: true;
  objectUrl: string;
  totalBytes: number;
}

export interface OffscreenErrorResponse {
  ok: false;
  code: string;
  message: string;
  /** Extra context: failed segment indices and the first failing URL. */
  detail?: string;
  /** The server that refused with 401/403, for "Allow <host> and retry" (D18). */
  host?: string;
}

export type OffscreenResponse = OffscreenAssembleResponse | OffscreenErrorResponse;

export function isOffscreenRequest(value: unknown): value is OffscreenRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { target?: unknown }).target === 'offscreen'
  );
}

export function isOffscreenProgress(value: unknown): value is OffscreenProgress {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.target === 'background' &&
    message.type === 'ASSEMBLE_PROGRESS' &&
    typeof message.taskId === 'string'
  );
}

/**
 * An error as it crosses from the offscreen document to the worker. An Error
 * does not survive the message bus, so every field the worker's copy needs is
 * listed here - one place to add a field, rather than two.
 */
export function toErrorResponse(err: unknown): OffscreenErrorResponse {
  const error = toMediaGrabError(err);
  return {
    ok: false,
    code: error.code,
    message: error.message,
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.host ? { host: error.host } : {}),
  };
}

/** The worker's side: the same error again, or a clear one if the document did not answer. */
export function fromErrorResponse(response: OffscreenErrorResponse | undefined): MediaGrabError {
  return new MediaGrabError(
    (response?.code as ErrorCode | undefined) ?? ErrorCode.INTERNAL,
    response?.message ?? 'The offscreen document did not respond',
    {
      ...(response?.detail ? { detail: response.detail } : {}),
      ...(response?.host ? { host: response.host } : {}),
    },
  );
}
