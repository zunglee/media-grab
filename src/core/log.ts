/**
 * Console logging. `debug` lines appear only when the user turns on debug
 * logging (settings -> advanced); info, warn and error always do. Outside debug
 * mode a string payload is redacted first, because media URLs carry tokens.
 *
 * Each extension context (worker, offscreen document, content script) has its
 * own copy of this module, so the debug switch is set in each of them.
 */
import { redactUrl } from './redact.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';

let debugEnabled = false;

export function setDebugLogging(enabled: boolean): void {
  debugEnabled = enabled;
}

export function debugLoggingEnabled(): boolean {
  return debugEnabled;
}

function emit(level: Level, scope: string, message: string, data?: unknown): void {
  if (level === 'debug' && !debugEnabled) return;
  const prefix = `[MediaGrab:${scope}]`;
  const payload = data === undefined ? [] : [debugEnabled ? data : redactValue(data)];
  if (level === 'error') console.error(prefix, message, ...payload);
  else if (level === 'warn') console.warn(prefix, message, ...payload);
  else console.log(prefix, message, ...payload);
}

function redactValue(data: unknown): unknown {
  if (typeof data === 'string') return redactUrl(data);
  return data;
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, data?: unknown) => emit('debug', scope, message, data),
    info: (message: string, data?: unknown) => emit('info', scope, message, data),
    warn: (message: string, data?: unknown) => emit('warn', scope, message, data),
    error: (message: string, data?: unknown) => emit('error', scope, message, data),
  };
}
