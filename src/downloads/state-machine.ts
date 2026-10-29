/**
 * Download state machine (PRD s39). Pure and total: every transition either
 * succeeds or returns a reason, and nothing else in the codebase is allowed to
 * assign to `task.state` directly.
 */
import { ALLOWED_TRANSITIONS, DownloadState, TERMINAL_STATES } from '../core/download-types.ts';
import type { DownloadCommand } from '../core/messages.ts';

export interface TransitionResult {
  ok: boolean;
  from: DownloadState;
  to: DownloadState;
  reason?: string;
}

export function canTransition(from: DownloadState, to: DownloadState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transition(from: DownloadState, to: DownloadState): TransitionResult {
  if (from === to) return { ok: false, from, to, reason: 'already in that state' };
  if (isTerminalState(from)) return { ok: false, from, to, reason: `${from} is terminal` };
  if (!canTransition(from, to))
    return { ok: false, from, to, reason: `${from} cannot become ${to}` };
  return { ok: true, from, to };
}

export function isTerminalState(state: DownloadState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Bytes are moving: the task occupies one of the `concurrentDownloads` slots.
 * A RESUMING task is waiting for a slot, like a QUEUED one.
 */
export function isActive(state: DownloadState): boolean {
  return state === DownloadState.DOWNLOADING || state === DownloadState.VERIFYING;
}

/**
 * Moving, or waiting for a slot to move: the tasks that progress without the
 * user doing anything, which is what the popup's "Downloads (n)" count means.
 * Paused and failed tasks wait for the user and are not counted.
 */
export function isInFlight(state: DownloadState): boolean {
  return isActive(state) || state === DownloadState.QUEUED || state === DownloadState.RESUMING;
}

/** What a user command means, given the current state. Null = not offered. */
export function commandTarget(
  state: DownloadState,
  command: DownloadCommand,
): DownloadState | null {
  switch (command) {
    case 'pause':
      return state === DownloadState.DOWNLOADING || state === DownloadState.QUEUED
        ? DownloadState.PAUSED
        : null;
    case 'resume':
      return state === DownloadState.PAUSED ? DownloadState.RESUMING : null;
    case 'cancel':
      return isTerminalState(state) ? null : DownloadState.CANCELLED;
    case 'retry':
      return state === DownloadState.FAILED ? DownloadState.QUEUED : null;
    default:
      return null;
  }
}
