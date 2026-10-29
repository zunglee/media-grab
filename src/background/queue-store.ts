/**
 * Keeps the download queue across the lives of the worker (ARCHITECTURE.md D16).
 *
 * A Chrome MV3 worker is stopped when idle and killed on update, and the
 * queue lives in its memory. Two saved copies bring it back:
 *
 *   storage.session  `downloads:queue`  every task, URLs included. Survives a
 *                                        worker restart; the browser clears it
 *                                        on an extension update or reload and
 *                                        on a browser restart.
 *   storage.local    `downloads:trace`  unfinished tasks WITHOUT URLs (name,
 *                                        kind, state, the browser's download
 *                                        id). Survives everything; keeps no
 *                                        bearer token on disk, the same stance
 *                                        as history.
 *
 *   worker starts -> the session copy (a worker restart), plus every trace
 *                    entry it lacks (all of them after an update or restart)
 *                 -> ask the browser about every file it holds
 *                 -> manager.restore() decides each task's state
 *                 -> save on every change that matters, and once now
 *
 * Progress alone never triggers a write: only what a new worker would need
 * to decide differently (ids, states, the browser's id, the file name, the
 * error). A task recovered from a trace is saved in the session copy too,
 * without a candidate - or the next worker restart would lose it.
 */
import type { DownloadItemInfo, StorageArea } from '../browser/api.ts';
import { browserApi } from '../browser/index.ts';
import type {
  DownloadManager,
  RecoveredTask,
  TaskRecord,
  TaskTrace,
} from '../downloads/manager.ts';

const QUEUE_KEY = 'downloads:queue';
const TRACE_KEY = 'downloads:trace';
/** 0.1.5 kept only browser-paused downloads, under this key; read once, then dropped. */
const LEGACY_PAUSED_KEY = 'downloads:paused';
/** After a failed write (storage full), how long before trying again. */
const SAVE_RETRY_MS = 5_000;

export interface QueueStorage {
  session: StorageArea;
  local: StorageArea;
}

/** Is there anything a new worker should take charge of? Cheap: three reads, in parallel. */
export async function hasSavedDownloads(storage: QueueStorage): Promise<boolean> {
  const [queue, legacy, trace] = await Promise.all([
    storage.session.get<TaskRecord[]>(QUEUE_KEY),
    storage.session.get<TaskRecord[]>(LEGACY_PAUSED_KEY),
    storage.local.get<TaskTrace[]>(TRACE_KEY),
  ]);
  return (queue?.length ?? 0) + (legacy?.length ?? 0) + (trace?.length ?? 0) > 0;
}

export interface CarryOptions {
  /** Runs with what was found, before the manager takes charge of it. */
  beforeRestore?: (recovered: RecoveredTask[]) => Promise<void>;
}

export async function carryDownloads(
  manager: Pick<DownloadManager, 'restore' | 'records' | 'traces' | 'onChange'>,
  storage: QueueStorage,
  options: CarryOptions = {},
): Promise<void> {
  const recovered = await withBrowserRecords(await readSaved(storage));
  await options.beforeRestore?.(recovered);

  // Start unset so the first save always writes: a stale copy must be replaced
  // even when nothing survived. A signature is kept only once its write has
  // succeeded, so a failed write (storage full) is written again - after a
  // pause, not on every progress tick.
  let savedQueue: string | undefined;
  let savedTrace: string | undefined;
  const writeChanges = async (): Promise<boolean> => {
    const records = manager.records();
    const traces = manager.traces();
    const queueSignature = signature(records.map((record) => record.view));
    const traceSignature = signature(traces);
    const writes: Array<Promise<void>> = [];
    if (queueSignature !== savedQueue) {
      writes.push(
        storage.session.set(QUEUE_KEY, records).then(() => {
          savedQueue = queueSignature;
        }),
      );
    }
    if (traceSignature !== savedTrace) {
      writes.push(
        storage.local.set(TRACE_KEY, traces).then(() => {
          savedTrace = traceSignature;
        }),
      );
    }
    const results = await Promise.allSettled(writes);
    return results.every((result) => result.status === 'fulfilled');
  };

  // One save at a time; a change made during a save is saved right after it.
  let running: Promise<void> | null = null;
  let again = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const save = (): Promise<void> => {
    if (retry) return Promise.resolve(); // the retry will save the latest state
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          if (!(await writeChanges())) {
            retry = setTimeout(() => {
              retry = null;
              void save();
            }, SAVE_RETRY_MS);
            return;
          }
        } while (again);
      } finally {
        // In the same step as the last check of `again`: a change arriving
        // after it starts a new save instead of waiting on this finished one.
        running = null;
      }
    })();
    return running;
  };

  // Listening before the restore: every change from here on is saved,
  // including those the restore itself makes (a file found finished).
  manager.onChange(() => void save());
  manager.restore(recovered);
  await storage.session.remove(LEGACY_PAUSED_KEY).catch(() => undefined);
  await save();
}

/**
 * The session copy exists only within one browser session and, when it is
 * there, is the fuller one: it has the URLs. The trace adds whatever the
 * session copy lacks - everything after an update or a restart cleared it,
 * and any task a failed session write left out.
 */
async function readSaved(storage: QueueStorage): Promise<RecoveredTask[]> {
  const [queue, legacy, trace] = await Promise.all([
    storage.session.get<TaskRecord[]>(QUEUE_KEY),
    storage.session.get<TaskRecord[]>(LEGACY_PAUSED_KEY),
    storage.local.get<TaskTrace[]>(TRACE_KEY),
  ]);
  const records = [...(queue ?? []), ...(legacy ?? [])];
  const inSession = new Set(records.map((record) => record.view.id));
  return [
    ...records.map((record) => ({ record })),
    ...(trace ?? []).filter((entry) => !inSession.has(entry.id)).map((entry) => ({ trace: entry })),
  ];
}

/** The browser is the truth about any file it holds; ask it about each one. */
async function withBrowserRecords(tasks: RecoveredTask[]): Promise<RecoveredTask[]> {
  return Promise.all(
    tasks.map(async (task) => {
      const id =
        'record' in task ? task.record.view.browserDownloadId : task.trace.browserDownloadId;
      if (id === undefined) return task;
      const browser: DownloadItemInfo | undefined = await browserApi()
        .downloads.search(id)
        .catch(() => undefined);
      return browser ? { ...task, browser } : task;
    }),
  );
}

/** What a new worker would decide on: never progress, which changes constantly. */
function signature(
  entries: Array<{
    id: string;
    state: string;
    filename: string;
    browserDownloadId?: number;
    attempts?: number;
    // The failed row's error, including the "Allow <host>" offer set after it.
    error?: { code: string; accessHost?: string };
  }>,
): string {
  return entries
    .map((entry) =>
      [
        entry.id,
        entry.state,
        entry.filename,
        entry.browserDownloadId ?? '',
        entry.attempts ?? '',
        entry.error?.code ?? '',
        entry.error?.accessHost ?? '',
      ].join('|'),
    )
    .join('\n');
}
