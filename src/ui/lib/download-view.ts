/**
 * How a download task is presented: which buttons its row offers, how its
 * size reads, and how a failure is worded. (Which tasks the Downloads tab
 * counts is `isInFlight`, a state rule, in downloads/state-machine.ts.) The rules for what a command
 * does live in downloads/state-machine.ts; this module only decides what the
 * UI shows, on top of them.
 */
import type { DownloadProgress, DownloadTaskView } from '../../core/download-types.ts';
import { ERROR_COPY, type ErrorCode } from '../../core/errors.ts';
import type { DownloadCommand } from '../../core/messages.ts';
import { commandTarget } from '../../downloads/state-machine.ts';
import { formatBytes } from '../../media/quality.ts';

/** In the order the row shows them. */
const COMMANDS: readonly DownloadCommand[] = ['pause', 'resume', 'retry', 'cancel'];

export const COMMAND_LABELS: Record<DownloadCommand, string> = {
  pause: 'Pause',
  resume: 'Resume',
  retry: 'Retry',
  cancel: 'Cancel',
};

/**
 * The commands the state machine accepts in the task's state, minus Pause for
 * a segmented download. Only the browser keeps a partial file to continue
 * from; a segmented download holds its bytes in memory, so pausing one throws
 * them away and Resume starts again from zero (ARCHITECTURE.md D5). A
 * segmented task that is somehow PAUSED still gets Resume. Retry is dropped for
 * a task recovered without its address after an update or restart (D16).
 */
export function offeredCommands(
  task: Pick<DownloadTaskView, 'state' | 'pausable' | 'canRetry'>,
): DownloadCommand[] {
  return COMMANDS.filter(
    (command) =>
      commandTarget(task.state, command) !== null &&
      (command !== 'pause' || task.pausable) &&
      (command !== 'retry' || task.canRetry !== false),
  );
}

/** "412 MB / ~1.46 GB": the total is marked "~" while it is a manifest's estimate. */
export function transferredLabel(progress: DownloadProgress): string {
  const received = formatBytes(progress.receivedBytes);
  if (!progress.totalBytes) return received;
  return `${received} / ${formatBytes(progress.totalBytes, progress.totalEstimated === true)}`;
}

/**
 * The host a failed row should offer to allow before retrying, if any: a 403
 * from a host MediaGrab has no access to (ARCHITECTURE.md D18). Never for a
 * task that cannot be retried.
 */
export function accessOffer(
  task: Pick<DownloadTaskView, 'state' | 'canRetry' | 'error'>,
): string | undefined {
  if (task.canRetry === false || !task.error?.accessHost) return undefined;
  return commandTarget(task.state, 'retry') !== null ? task.error.accessHost : undefined;
}

/**
 * A failed row's two lines: what the kind of failure means, then what exactly
 * happened. The second is skipped when it would only repeat the first. When
 * the row offers to allow a host (`accessOffer`), the headline says so instead
 * of the generic copy for the code, which would send the user to reload.
 */
export function errorLines(
  error: { code: string; message: string },
  allowHost?: string,
): {
  headline: string;
  detail?: string;
} {
  const headline = allowHost
    ? `${allowHost} refused MediaGrab. Allowing it lets MediaGrab say which page this is from.`
    : (ERROR_COPY[error.code as ErrorCode] ?? error.message);
  const detail = error.message.trim();
  return detail && detail !== headline ? { headline, detail } : { headline };
}
