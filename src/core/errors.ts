/**
 * Classified errors. Every failure surfaced to the user carries one of these codes
 * so the UI can explain it and diagnostics can aggregate it (PRD s50).
 */
export const ErrorCode = {
  MEDIA_NOT_FOUND: 'MEDIA_NOT_FOUND',
  STREAM_EXPIRED: 'STREAM_EXPIRED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  DRM_PROTECTED: 'DRM_PROTECTED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  SERVER_REJECTED: 'SERVER_REJECTED',
  UNSUPPORTED_MANIFEST: 'UNSUPPORTED_MANIFEST',
  AUDIO_VIDEO_MISMATCH: 'AUDIO_VIDEO_MISMATCH',
  SEGMENT_FAILED: 'SEGMENT_FAILED',
  INVALID_MEDIA: 'INVALID_MEDIA',
  BROWSER_PERMISSION: 'BROWSER_PERMISSION',
  SITE_ADAPTER_ERROR: 'SITE_ADAPTER_ERROR',
  DISK_ERROR: 'DISK_ERROR',
  CANCELLED: 'CANCELLED',
  /** MediaGrab stopped mid-download: its worker was restarted, or the extension or browser was (D16). */
  INTERRUPTED: 'INTERRUPTED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Codes that are worth retrying automatically. */
const RETRYABLE = new Set<ErrorCode>([
  ErrorCode.NETWORK_ERROR,
  ErrorCode.SEGMENT_FAILED,
  ErrorCode.SERVER_REJECTED,
]);

/** Codes where retrying can never help, so the queue must stop immediately. */
const TERMINAL = new Set<ErrorCode>([
  ErrorCode.DRM_PROTECTED,
  ErrorCode.AUTH_REQUIRED,
  ErrorCode.UNSUPPORTED_MANIFEST,
  ErrorCode.INVALID_MEDIA,
  ErrorCode.BROWSER_PERMISSION,
  ErrorCode.CANCELLED,
]);

export class MediaGrabError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly httpStatus?: number;
  /**
   * Hostname of the server that refused, for a 401/403. The failed row uses it
   * to offer "Allow <host> and retry" (ARCHITECTURE.md D18).
   */
  readonly host?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { detail?: string; httpStatus?: number; cause?: unknown; host?: string },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'MediaGrabError';
    this.code = code;
    this.detail = options?.detail;
    this.httpStatus = options?.httpStatus;
    this.host = options?.host;
  }

  get retryable(): boolean {
    return isRetryable(this.code);
  }
}

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function isTerminal(code: ErrorCode): boolean {
  return TERMINAL.has(code);
}

/** Map an HTTP status onto a code so download failures classify themselves. */
export function codeForHttpStatus(status: number): ErrorCode {
  if (status === 401 || status === 407) return ErrorCode.AUTH_REQUIRED;
  if (status === 403) return ErrorCode.STREAM_EXPIRED;
  if (status === 404 || status === 410) return ErrorCode.MEDIA_NOT_FOUND;
  if (status === 416) return ErrorCode.INVALID_MEDIA;
  if (status === 429 || status >= 500) return ErrorCode.SERVER_REJECTED;
  return ErrorCode.NETWORK_ERROR;
}

/** Normalize anything thrown into a MediaGrabError without losing the cause. */
export function toMediaGrabError(
  err: unknown,
  fallback: ErrorCode = ErrorCode.INTERNAL,
): MediaGrabError {
  if (err instanceof MediaGrabError) return err;
  if (err instanceof Error) {
    const isAbort = err.name === 'AbortError';
    return new MediaGrabError(isAbort ? ErrorCode.CANCELLED : fallback, err.message, {
      cause: err,
    });
  }
  return new MediaGrabError(fallback, String(err));
}

/**
 * What each code means, in the user's words: the headline of a failed row.
 * The error's own message - which says what exactly happened, e.g. "made of 3
 * separate parts" - is shown under it (ui/lib/download-view.ts `errorLines`).
 */
export const ERROR_COPY: Record<ErrorCode, string> = {
  MEDIA_NOT_FOUND: 'The media is no longer at that address.',
  STREAM_EXPIRED: 'The link expired. Reload the page and scan again.',
  AUTH_REQUIRED: 'This media requires you to be signed in. MediaGrab does not bypass sign-in.',
  DRM_PROTECTED: 'Protected content cannot be downloaded.',
  NETWORK_ERROR: 'The network request failed.',
  SERVER_REJECTED: 'The server refused the request.',
  UNSUPPORTED_MANIFEST: 'This stream format is not supported yet.',
  AUDIO_VIDEO_MISMATCH: 'The audio and video streams do not line up.',
  SEGMENT_FAILED: 'Part of the stream could not be downloaded.',
  INVALID_MEDIA: 'The downloaded data is not valid media.',
  BROWSER_PERMISSION: 'MediaGrab needs permission for this site.',
  SITE_ADAPTER_ERROR: 'The site-specific detector failed. Falling back to generic detection.',
  DISK_ERROR: 'The file could not be written.',
  CANCELLED: 'Cancelled.',
  INTERRUPTED: 'MediaGrab was restarted during this download.',
  INTERNAL: 'Something went wrong inside MediaGrab.',
};
