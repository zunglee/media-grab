/**
 * Why the browser stopped a download, in MediaGrab's terms.
 *
 * `downloads.onChanged` reports an interrupted download with the browser's
 * reason code (Chrome's `downloads.InterruptReason`; Firefox uses the same
 * names). Shown raw, "USER_CANCELED" or "FILE_NO_SPACE" reads as a network
 * failure with a Retry button - so each family maps onto the error code whose
 * copy tells the user what actually happened.
 */
import { ErrorCode, MediaGrabError } from '../core/errors.ts';

const SERVER_REASONS: Record<string, ErrorCode> = {
  SERVER_UNAUTHORIZED: ErrorCode.AUTH_REQUIRED,
  SERVER_FORBIDDEN: ErrorCode.STREAM_EXPIRED,
  SERVER_BAD_CONTENT: ErrorCode.MEDIA_NOT_FOUND,
};

export function interruptionError(reason: string | undefined): MediaGrabError {
  const code = codeFor(reason ?? '');
  const detail = reason ? { detail: `browser reason: ${reason}` } : undefined;
  return new MediaGrabError(code, messageFor(code), detail);
}

function codeFor(reason: string): ErrorCode {
  if (reason === 'USER_CANCELED') return ErrorCode.CANCELLED;
  if (reason.startsWith('FILE_')) return ErrorCode.DISK_ERROR;
  const server = SERVER_REASONS[reason];
  if (server) return server;
  if (reason.startsWith('SERVER_')) return ErrorCode.SERVER_REJECTED;
  // NETWORK_*, USER_SHUTDOWN, CRASH and anything newer than this list.
  return ErrorCode.NETWORK_ERROR;
}

function messageFor(code: ErrorCode): string {
  switch (code) {
    case ErrorCode.CANCELLED:
      return "Cancelled in the browser's download list.";
    case ErrorCode.DISK_ERROR:
      return 'The browser could not write the file (disk full, no access, or blocked).';
    default:
      return 'The browser stopped the download before it finished.';
  }
}
