/**
 * Download manager (PRD s10, s38, s39).
 *
 * Owns the queue: which task runs next, how many run at once, what state each
 * one is in, when a failure is retried, and what the UI is told. It does not
 * know how bytes are fetched - that is an engine's job (engines.ts) - and it
 * never assigns a state except through the state machine.
 *
 * Life of a task:
 *
 *   enqueue ─> QUEUED ─pump─> DOWNLOADING ──engine.start──> handed to the browser
 *                                  │                              │
 *                   retryable error, attempts left      downloads.onChanged
 *                        -> FAILED -> QUEUED            complete -> COMPLETED
 *                                                       paused / resumed there
 *                                                         -> PAUSED / DOWNLOADING
 *                                                       cancelled there -> CANCELLED
 *                                                       interrupted -> retry or FAILED
 *
 * Pause, honestly: a direct file is paused and resumed by the browser, which
 * keeps the partial file. A segmented download has no partial file anywhere
 * (its bytes live in memory until assembly), so pausing it stops the fetch and
 * resuming starts it again. The UI says so (README, "Known limitations").
 *
 * Durability (ARCHITECTURE.md D16). The queue lives in memory, but the worker
 * does not: Chrome stops it when idle and kills it on update. `records()` and
 * `traces()` describe the queue for background/queue-store.ts to save, and
 * `restore()` takes charge of it again when a new worker starts:
 *
 *   saved record/trace + what the browser says now
 *     queued, waiting for a slot   -> queued again
 *     the browser holds the file   -> follow the browser: finished (-> history),
 *                                     paused, running, or gone
 *     caught mid-attempt           -> failed: interrupted, with Retry
 *     known only from a trace      -> as above, but never Retry: a trace keeps
 *                                     no URL to fetch again
 */
import type { DownloadChange, DownloadItemInfo } from '../browser/api.ts';
import { browserApi } from '../browser/index.ts';
import {
  type DownloadRequest,
  DownloadState,
  type DownloadStrategy,
  type DownloadTaskView,
} from '../core/download-types.ts';
import { ErrorCode, MediaGrabError, toMediaGrabError } from '../core/errors.ts';
import { createLogger } from '../core/log.ts';
import type { DownloadCommand } from '../core/messages.ts';
import type { MediaCandidate, MediaKind, MediaVariant, Saveability } from '../core/types.ts';
import { sameRenditionUrl } from '../media/dedupe.ts';
import { isSaveable, renditionSaveability, saveabilityOf } from '../media/saveability.ts';
import type { Settings } from '../storage/settings.ts';
import { BrowserProgressPoller } from './browser-progress.ts';
import {
  DEFAULT_ENGINES,
  type DownloadEngine,
  type Handoff,
  type ProgressUpdate,
} from './engines.ts';
import { interruptionError } from './interrupt-reasons.ts';
import { ProgressTracker } from './progress.ts';
import { RefererRules } from './referer-rules.ts';
import { commandTarget, isActive, isTerminalState, transition } from './state-machine.ts';
import { createTask, filenameFor, renditionToFetch } from './task-factory.ts';

const log = createLogger('downloads');

/** How long a finished task stays in the list before history takes over. */
const FINISHED_TASK_TTL_MS = 60_000;
/** Progress is chatty (one reading per segment); the UI needs a few per second. */
const PROGRESS_EMIT_MS = 250;

interface Task {
  view: DownloadTaskView;
  request: DownloadRequest;
  tracker: ProgressTracker;
  /**
   * What the task downloads. Null for a task recovered from a URL-free trace
   * after an update or restart: it can be followed, paused, resumed and
   * cancelled through the browser, but never fetched again.
   */
  candidate: MediaCandidate | null;
  variant: MediaVariant | undefined;
  engine: DownloadEngine;
  /** Aborts the attempt in progress. Null when no attempt is running. */
  controller: AbortController | null;
  /** Frees what the engine holds for the handed-over file (see Handoff.release). */
  release: (() => void) | null;
  /** Referer rules this task holds (referer-rules.ts); released when it settles. */
  referers: Array<() => void>;
  /**
   * Hosts that refused this task after a redirect (a 403 names the host that
   * answered). The plan does not list them, so a retry holds a rule for them
   * too - otherwise granting the host the row offered would change nothing.
   */
  refusedHosts: Set<string>;
}

/**
 * Everything needed to rebuild a task in a new worker. JSON-safe. It holds the
 * media's URLs, so it is kept in `storage.session` only, which the browser
 * clears at restart. `candidate` is null for a task that was itself recovered
 * from a trace: it is still saved, or the next worker restart would lose it.
 */
export interface TaskRecord {
  view: DownloadTaskView;
  request: DownloadRequest;
  candidate: MediaCandidate | null;
  variant?: MediaVariant;
}

/**
 * What is kept of an unfinished task across an extension update or a browser
 * restart, in `storage.local`: no URLs, the same stance as history. The
 * browser's own download id is enough to follow a file the browser holds.
 */
export interface TaskTrace {
  id: string;
  filename: string;
  kind: MediaKind;
  strategy: DownloadStrategy;
  state: DownloadState;
  createdAt: number;
  browserDownloadId?: number;
}

/** A task found again at start-up, with the browser's record of its file now. */
export type RecoveredTask =
  | { record: TaskRecord; browser?: DownloadItemInfo }
  | { trace: TaskTrace; browser?: DownloadItemInfo };

export type DownloadsListener = (tasks: DownloadTaskView[]) => void;
export type CompletedListener = (task: DownloadTaskView) => void;

export class DownloadManager {
  private readonly tasks = new Map<string, Task>();
  private readonly changeListeners = new Set<DownloadsListener>();
  private readonly completedListeners = new Set<CompletedListener>();
  private readonly poller = new BrowserProgressPoller();
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  /** True while restore() rebuilds the queue: nothing starts until all of it is back. */
  private restoring = false;

  constructor(
    private settings: Settings,
    private readonly engines: Record<DownloadStrategy, DownloadEngine> = DEFAULT_ENGINES,
    private readonly refererRules: Pick<RefererRules, 'hold'> = new RefererRules(),
  ) {}

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.pump();
  }

  /** Every change to any task, with the full list. */
  onChange(listener: DownloadsListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Exactly once per task, when the browser reports the file complete. */
  onTaskCompleted(listener: CompletedListener): () => void {
    this.completedListeners.add(listener);
    return () => this.completedListeners.delete(listener);
  }

  list(): DownloadTaskView[] {
    // Lazy rather than on a timer: an MV3 worker is killed constantly, so a
    // timer is not a reliable place to hang cleanup off.
    this.pruneFinished();
    return [...this.tasks.values()]
      .map((task) => task.view)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Queue a download. `variant` selects a rendition of a manifest; omit it and
   * the best rendition is chosen (or none, for a direct file). Returns the task
   * id - an existing one if the same media is already downloading.
   */
  enqueue(candidate: MediaCandidate, chosen?: MediaVariant): string {
    if (candidate.drm === true) {
      throw new MediaGrabError(ErrorCode.DRM_PROTECTED, 'Protected content cannot be downloaded.');
    }
    const variant = renditionToFetch(candidate, chosen);
    // The popup never offers these (D21); a stale popup or a shortcut still might.
    const status = variant ? renditionSaveability(candidate, variant) : saveabilityOf(candidate);
    if (!isSaveable(status)) throw refusal(status);

    // A double click on "Best download" joins the download already running
    // instead of starting a second one. A finished or failed download is fair
    // game: asking again means the user wants it again.
    const running = this.findRunningDuplicate(candidate, variant);
    if (running) {
      log.info(`download for ${running.view.filename} is already running; not queueing a second`);
      return running.view.id;
    }

    this.sequence += 1;
    const taskId = `t${Date.now().toString(36)}-${this.sequence}`;
    const { request, view, tracker } = createTask({
      taskId,
      candidate,
      variant,
      settings: this.settings,
      now: Date.now(),
    });

    const engine = this.engines[request.strategy];
    view.pausable = engine.browserFetches;
    this.tasks.set(taskId, {
      view,
      request,
      tracker,
      candidate,
      variant,
      engine,
      controller: null,
      release: null,
      referers: [],
      refusedHosts: new Set(),
    });
    this.emit();
    this.pump();
    return taskId;
  }

  command(taskId: string, command: DownloadCommand): boolean {
    const task = this.tasks.get(taskId);
    if (!task || commandTarget(task.view.state, command) === null) return false;
    if (command === 'retry' && !task.candidate) return false; // nothing left to fetch (D16)

    switch (command) {
      case 'cancel':
        this.cancel(task);
        break;
      case 'pause':
        this.pause(task);
        break;
      case 'resume':
        this.resume(task);
        break;
      case 'retry':
        task.view.attempts = 0;
        delete task.view.error;
        this.setState(task, DownloadState.QUEUED);
        break;
    }

    this.emit();
    this.pump();
    return true;
  }

  /** Every task, as a new worker would need it. */
  records(): TaskRecord[] {
    return [...this.tasks.values()].map((task) => ({
      view: task.view,
      request: task.request,
      candidate: task.candidate,
      ...(task.variant ? { variant: task.variant } : {}),
    }));
  }

  /** Unfinished tasks, without URLs: what an update or restart may leave. */
  traces(): TaskTrace[] {
    return [...this.tasks.values()]
      .filter(
        (task) => !isTerminalState(task.view.state) && task.view.state !== DownloadState.FAILED,
      )
      .map(({ view }) => ({
        id: view.id,
        filename: view.filename,
        kind: view.kind,
        strategy: view.strategy,
        state: view.state,
        createdAt: view.createdAt,
        ...(view.browserDownloadId !== undefined
          ? { browserDownloadId: view.browserDownloadId }
          : {}),
      }));
  }

  /**
   * Take charge again of the tasks a previous worker left (see the header).
   * The browser is the truth about any file it holds; the saved state only
   * says what MediaGrab last knew.
   */
  restore(recovered: RecoveredTask[]): void {
    // A task that fails during its recovery can be queued again at once; the
    // queue must not start it while running tasks are still being brought
    // back, or more would run than the settings allow.
    this.restoring = true;
    try {
      for (const item of recovered) this.recover(item);
    } finally {
      this.restoring = false;
    }
    if (recovered.length > 0) {
      this.emit();
      this.pump();
    }
  }

  private recover(item: RecoveredTask): void {
    const record = 'record' in item ? item.record : undefined;
    const view = record ? { ...record.view } : viewFromTrace((item as { trace: TaskTrace }).trace);
    if (this.tasks.has(view.id)) return;

    const engine = this.engines[view.strategy];
    const tracker = new ProgressTracker(view.progress.totalBytes);
    tracker.update(view.progress.receivedBytes);
    const task: Task = {
      view: { ...view, pausable: engine.browserFetches },
      request: record?.request ?? requestFromView(view),
      tracker,
      candidate: record?.candidate ?? null,
      variant: record?.variant,
      engine,
      controller: null,
      release: null,
      referers: [],
      // A host the failed row offered stays a host to name on the retry, even
      // after the worker that saw the refusal is gone (D18).
      refusedHosts: new Set(view.error?.accessHost ? [view.error.accessHost] : []),
    };
    this.tasks.set(view.id, task);

    const { state, browserDownloadId } = task.view;
    if (isTerminalState(state) || state === DownloadState.FAILED) return; // shown as it was
    if (browserDownloadId !== undefined) {
      this.followBrowser(task, item.browser);
    } else if (
      task.candidate &&
      (state === DownloadState.QUEUED ||
        state === DownloadState.RESUMING ||
        state === DownloadState.PAUSED)
    ) {
      // Not started, or waiting to start again: the queue picks it up.
    } else {
      // Planning, fetching or assembling when the worker stopped - that work
      // died with it - or known only from a trace.
      this.fail(task, interruptedError(task.candidate !== null));
    }
  }

  /** A recovered task whose file the browser was holding: do what the browser says. */
  private followBrowser(task: Task, item: DownloadItemInfo | undefined): void {
    if (!item) {
      this.fail(
        task,
        new MediaGrabError(ErrorCode.INTERRUPTED, 'The browser no longer lists this download.'),
      );
    } else if (item.state === 'complete') {
      this.complete(task, item);
    } else if (item.paused) {
      // Firefox reports a paused download as interrupted (see DownloadChange).
      this.pausedInTheBrowser(task);
      void this.holdReferer(task, [task.request.url]);
    } else if (item.state === 'in_progress') {
      // A new worker cleared the old worker's Referer rules; the browser may
      // still need it (a resume re-requests the file).
      void this.holdReferer(task, [task.request.url]);
      if (task.view.state === DownloadState.PAUSED) {
        this.setState(task, DownloadState.RESUMING);
        this.setState(task, DownloadState.DOWNLOADING);
      }
      if (task.engine.browserFetches) this.watchBrowserProgress(task);
    } else {
      this.interrupted(task, interruptionError(item.error));
    }
  }

  /**
   * The browser's own record of a file changed (downloads.onChanged): it
   * finished, or the user paused, resumed or cancelled it in the browser's
   * download list, or the browser gave up on it. Resolves once handled.
   */
  async handleBrowserDownloadChanged(change: DownloadChange): Promise<void> {
    const task = [...this.tasks.values()].find(
      (entry) => entry.view.browserDownloadId === change.id,
    );
    if (!task) return;

    if (change.state === 'complete') {
      this.complete(task, await this.browserRecord(change.id));
    } else if (change.state === 'interrupted') {
      // Firefox pauses by interrupting (see DownloadChange); only `paused`
      // tells that from a cancel. When the event does not say, ask.
      const paused = change.paused ?? (await this.browserRecord(change.id))?.paused === true;
      if (paused) this.pausedInTheBrowser(task);
      else this.interrupted(task, interruptionError(change.error));
    } else if (change.paused === true) {
      this.pausedInTheBrowser(task);
    } else if (change.paused === false && task.view.state === DownloadState.PAUSED) {
      // Not paused any more: resumed - or, on Firefox, cancelled while paused,
      // which changes only `paused` (the state was already "interrupted").
      const item = await this.browserRecord(change.id);
      if (item?.state === 'in_progress') {
        this.setState(task, DownloadState.RESUMING);
        this.setState(task, DownloadState.DOWNLOADING);
        this.watchBrowserProgress(task);
      } else {
        this.interrupted(task, interruptionError(item?.error ?? 'USER_CANCELED'));
      }
    } else {
      return;
    }
    this.emit();
    this.pump();
  }

  private complete(task: Task, item: DownloadItemInfo | undefined): void {
    // Once only, and never for a task the user already cancelled.
    if (task.view.state === DownloadState.COMPLETED) return;
    if (!this.setState(task, DownloadState.COMPLETED)) return;
    // The last poll may have been a moment before the end, or never happened
    // (a small file): the browser's own record says how big the whole file is.
    const { receivedBytes, totalBytes } = task.view.progress;
    const whole = item?.bytesReceived || Math.max(receivedBytes, totalBytes ?? 0);
    task.tracker.setTotal(whole);
    task.tracker.update(whole);
    task.view.progress = task.tracker.snapshot();
    task.view.completedAt = Date.now();
    this.settle(task);
    for (const listener of this.completedListeners) listener(task.view);
  }

  /** The user paused it from the browser's own list; the browser keeps the partial file. */
  private pausedInTheBrowser(task: Task): void {
    if (!this.setState(task, DownloadState.PAUSED)) return;
    task.tracker.pause();
    this.poller.stop(task.view.id);
  }

  /** The browser stopped the file: the user cancelled it there, or it failed. */
  private interrupted(task: Task, error: MediaGrabError): void {
    if (error.code === ErrorCode.CANCELLED) {
      this.cancel(task);
      return;
    }
    // A retry is a new browser download; the interrupted one is finished with.
    this.poller.stop(task.view.id);
    this.forgetBrowserDownload(task);
    this.retryOrFail(task, error);
  }

  private browserRecord(id: number): Promise<DownloadItemInfo | undefined> {
    return browserApi()
      .downloads.search(id)
      .catch(() => undefined);
  }

  // ─── Scheduling ────────────────────────────────────────────────────────────

  /** Start queued tasks until every slot is taken. */
  private pump(): void {
    if (this.restoring) return;
    const slots = this.settings.downloads.concurrentDownloads;
    let busy = [...this.tasks.values()].filter((task) => isActive(task.view.state)).length;

    const waiting = [...this.tasks.values()]
      .filter(
        (task) =>
          task.view.state === DownloadState.QUEUED || task.view.state === DownloadState.RESUMING,
      )
      .sort((a, b) => a.view.createdAt - b.view.createdAt);

    for (const task of waiting) {
      if (busy >= slots) return;
      busy += 1;
      void this.run(task);
    }
  }

  /** One attempt. Moves the task to DOWNLOADING synchronously, before the first await. */
  private async run(task: Task): Promise<void> {
    const candidate = task.candidate;
    if (!candidate) {
      // A trace keeps no address: there is nothing to fetch again.
      this.fail(task, interruptedError(false));
      this.emit();
      return;
    }
    if (!this.setState(task, DownloadState.DOWNLOADING)) return;
    const controller = new AbortController();
    task.controller = controller;
    task.view.attempts += 1;
    this.emit();

    let handoff: Handoff;
    try {
      handoff = await task.engine.start({
        request: task.request,
        candidate,
        variant: task.variant,
        settings: this.settings,
        signal: controller.signal,
        onProgress: (update) => this.recordProgress(task, update),
        onVerifying: () => {
          this.setState(task, DownloadState.VERIFYING);
          this.emit();
        },
        rename: (extension) => {
          const filename = filenameFor({
            candidate,
            variant: task.variant,
            settings: this.settings,
            extension,
          });
          task.view.filename = task.request.filename = filename;
          this.emit();
          return filename;
        },
        willFetch: (urls) => this.holdReferer(task, urls),
      });
    } catch (err) {
      // Paused or cancelled mid-attempt: that command already set the state,
      // and whatever error the abort caused is a consequence, not a failure.
      if (controller.signal.aborted) return;
      const error = toMediaGrabError(err);
      // The user closed the Save As dialog: a choice, not a failure.
      if (error.code === ErrorCode.CANCELLED) this.cancel(task);
      else this.retryOrFail(task, error);
      this.emit();
      return;
    } finally {
      if (task.controller === controller) task.controller = null;
    }

    if (controller.signal.aborted) {
      // The user stopped the task while the browser was being handed the file.
      // Take the file back, or resuming would produce a duplicate.
      void browserApi()
        .downloads.cancel(handoff.browserDownloadId)
        .catch(() => undefined);
      handoff.release?.();
      return;
    }

    task.view.browserDownloadId = handoff.browserDownloadId;
    task.release = handoff.release ?? null;
    if (task.engine.browserFetches) this.watchBrowserProgress(task);
    this.emit();
  }

  private retryOrFail(task: Task, error: MediaGrabError): void {
    const allowed = task.engine.retriesItself ? 0 : this.settings.downloads.retryCount;
    if (task.candidate && error.retryable && task.view.attempts <= allowed) {
      log.info(`retrying ${task.view.id} (${task.view.attempts}/${allowed}) after ${error.code}`);
      this.setState(task, DownloadState.FAILED);
      this.setState(task, DownloadState.QUEUED);
    } else {
      this.fail(task, error);
    }
    this.emit();
    this.pump();
  }

  // ─── Commands ──────────────────────────────────────────────────────────────

  private cancel(task: Task): void {
    task.controller?.abort();
    if (task.view.browserDownloadId !== undefined) {
      void browserApi()
        .downloads.cancel(task.view.browserDownloadId)
        .catch(() => undefined);
    }
    this.setState(task, DownloadState.CANCELLED);
    this.settle(task);
  }

  private pause(task: Task): void {
    this.setState(task, DownloadState.PAUSED);
    task.tracker.pause();

    if (this.browserHoldsPartialFile(task)) {
      this.poller.stop(task.view.id);
      const id = task.view.browserDownloadId as number;
      void browserApi()
        .downloads.pause(id)
        .catch((err) => log.warn('the browser refused to pause', toMediaGrabError(err).message));
      return;
    }

    // Nothing on disk to resume into: stop fetching; resume starts again.
    task.controller?.abort();
    this.forgetBrowserDownload(task);
  }

  private resume(task: Task): void {
    this.setState(task, DownloadState.RESUMING);
    if (!this.browserHoldsPartialFile(task)) return; // pump() restarts it

    // The browser continues from its partial file; no new attempt is started.
    this.setState(task, DownloadState.DOWNLOADING);
    this.watchBrowserProgress(task);
    const id = task.view.browserDownloadId as number;
    void browserApi()
      .downloads.resume(id)
      .catch((err) => {
        this.fail(
          task,
          new MediaGrabError(
            ErrorCode.NETWORK_ERROR,
            'The browser could not resume this download.',
            {
              detail: toMediaGrabError(err).message,
            },
          ),
        );
        this.emit();
        this.pump();
      });
  }

  /** A direct file the browser has already started writing. */
  private browserHoldsPartialFile(task: Task): boolean {
    return task.engine.browserFetches && task.view.browserDownloadId !== undefined;
  }

  // ─── Progress ──────────────────────────────────────────────────────────────

  private recordProgress(task: Task, update: ProgressUpdate): void {
    if (update.totalBytes !== undefined) {
      task.tracker.setTotal(update.totalBytes, update.totalEstimated === true);
    }
    if (update.segmentsTotal !== undefined) {
      task.tracker.setSegments(update.segmentsDone ?? 0, update.segmentsTotal);
    }
    task.tracker.update(update.receivedBytes);
    task.view.progress = task.tracker.snapshot();
    task.view.updatedAt = Date.now();
    this.emitProgressSoon();
  }

  private watchBrowserProgress(task: Task): void {
    const id = task.view.browserDownloadId;
    if (id === undefined) return;
    this.poller.watch(task.view.id, id, (item: DownloadItemInfo) => {
      const total = item.state === 'complete' ? item.bytesReceived : item.totalBytes;
      this.recordProgress(task, {
        receivedBytes: item.bytesReceived,
        ...(total > 0 ? { totalBytes: total } : {}),
      });
    });
  }

  // ─── State bookkeeping ─────────────────────────────────────────────────────

  /** The only writer of `task.view.state`. Returns false for an illegal move. */
  private setState(task: Task, state: DownloadState): boolean {
    if (task.view.state === state) return true;
    const result = transition(task.view.state, state);
    if (!result.ok) {
      log.warn(`illegal transition ignored: ${result.from} -> ${result.to} (${result.reason})`);
      return false;
    }
    task.view.state = state;
    task.view.updatedAt = Date.now();
    return true;
  }

  private fail(task: Task, error: MediaGrabError): void {
    // Cancelling makes the browser report the file as interrupted; a cancelled
    // task must not then show that as an error.
    if (!this.setState(task, DownloadState.FAILED)) return;
    task.view.error = {
      code: error.code,
      message: error.detail ? `${error.message} (${error.detail})` : error.message,
    };
    this.settle(task);
    this.forgetBrowserDownload(task);
    if (error.code === ErrorCode.STREAM_EXPIRED && error.host) task.refusedHosts.add(error.host);
    void this.offerAccess(task, error);
    log.warn(`download ${task.view.id} failed`, `${error.code}: ${error.message}`);
  }

  /** Stop everything that is still running on the task's behalf. */
  private settle(task: Task): void {
    this.poller.stop(task.view.id);
    task.controller?.abort();
    task.controller = null;
    task.release?.();
    task.release = null;
    for (const release of task.referers.splice(0)) release();
  }

  /**
   * A 403 is how most CDNs refuse a request that names no page. If MediaGrab
   * has no access to the refusing host it could not name the page there, and
   * granting that host is what would fix it: say so on the failed row (D18).
   */
  private async offerAccess(task: Task, error: MediaGrabError): Promise<void> {
    if (error.code !== ErrorCode.STREAM_EXPIRED || !task.candidate) return;
    const host = error.host ?? hostOf(task.request.url);
    if (!host) return;
    // The scheme the task fetches over: a grant for the other one would not help.
    const scheme = task.request.url.startsWith('http:') ? 'http' : 'https';
    const granted = await browserApi()
      .permissions.contains([`${scheme}://${host}/*`])
      .catch(() => false);
    if (granted || task.view.state !== DownloadState.FAILED || !task.view.error) return;
    task.view.error = { ...task.view.error, accessHost: host };
    this.emit();
  }

  /** Name the task's page as Referer to these hosts until the task settles. */
  private async holdReferer(task: Task, urls: string[]): Promise<void> {
    if (!task.request.pageUrl) return;
    const refused = [...task.refusedHosts].map((host) => `https://${host}/`);
    const release = await this.refererRules.hold([...urls, ...refused], task.request.pageUrl);
    // Setting the rule takes a moment; the task may have settled meanwhile (a
    // cancel during the engine's first request, a restored file finishing).
    // Nothing would release the rule later, so release it now.
    const { state } = task.view;
    if (isTerminalState(state) || state === DownloadState.FAILED) release();
    else task.referers.push(release);
  }

  /** A retry or a restart creates a new browser download; stop matching the old one. */
  private forgetBrowserDownload(task: Task): void {
    delete task.view.browserDownloadId;
  }

  /**
   * The same rendition, still on its way. Same URL (signatures and cache
   * busters aside) is not enough on its own: every DASH representation shares
   * the MPD's URL, so the variant id must match too.
   */
  private findRunningDuplicate(
    candidate: MediaCandidate,
    variant: MediaVariant | undefined,
  ): Task | undefined {
    const url = variant?.url ?? candidate.url;
    return [...this.tasks.values()].find(
      (task) =>
        !isTerminalState(task.view.state) &&
        task.view.state !== DownloadState.FAILED &&
        task.variant?.id === variant?.id &&
        sameRenditionUrl(task.request.url, url),
    );
  }

  /**
   * Drop finished tasks the UI has had time to show; history keeps the record.
   * Deliberately silent: it runs inside `list()`, and emitting there would recurse.
   */
  private pruneFinished(): void {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (isTerminalState(task.view.state) && now - task.view.updatedAt > FINISHED_TASK_TTL_MS) {
        this.tasks.delete(id);
      }
    }
  }

  private emit(): void {
    if (this.restoring) return; // restore() emits once, with the whole queue back
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    const snapshot = this.list();
    for (const listener of this.changeListeners) listener(snapshot);
  }

  private emitProgressSoon(): void {
    this.progressTimer ??= setTimeout(() => this.emit(), PROGRESS_EMIT_MS);
  }
}

/** Why a recovered task stopped; `canRetry` says whether its address was kept. */
function interruptedError(canRetry: boolean): MediaGrabError {
  return new MediaGrabError(
    ErrorCode.INTERRUPTED,
    canRetry
      ? 'MediaGrab was restarted while this was downloading. Retry to start it again.'
      : 'An update or a browser restart interrupted this download. Scan the page again to download it.',
  );
}

/** The view of a task known only from its trace: no URLs, no progress. */
function viewFromTrace(trace: TaskTrace): DownloadTaskView {
  const now = Date.now();
  return {
    id: trace.id,
    filename: trace.filename,
    url: '',
    pageUrl: '',
    state: trace.state,
    strategy: trace.strategy,
    pausable: false,
    kind: trace.kind,
    progress: { receivedBytes: 0, speedBps: 0 },
    createdAt: trace.createdAt,
    updatedAt: now,
    attempts: 0,
    canRetry: false,
    ...(trace.browserDownloadId !== undefined
      ? { browserDownloadId: trace.browserDownloadId }
      : {}),
  };
}

function requestFromView(view: DownloadTaskView): DownloadRequest {
  return {
    taskId: view.id,
    url: view.url,
    strategy: view.strategy,
    filename: view.filename,
    kind: view.kind,
    pageUrl: view.pageUrl,
  };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Why the scan said this cannot be saved, as the error the popup shows. */
function refusal(status: Saveability | undefined): MediaGrabError {
  switch (status) {
    case 'drm':
      return new MediaGrabError(ErrorCode.DRM_PROTECTED, 'Protected content cannot be downloaded.');
    case 'too-large':
      return new MediaGrabError(ErrorCode.DISK_ERROR, 'Too large to assemble in the browser.');
    case 'encrypted':
      return new MediaGrabError(ErrorCode.UNSUPPORTED_MANIFEST, 'This stream is encrypted.');
    case 'live':
      return new MediaGrabError(
        ErrorCode.UNSUPPORTED_MANIFEST,
        'Live streams cannot be saved yet.',
      );
    case 'multi-period':
      return new MediaGrabError(
        ErrorCode.UNSUPPORTED_MANIFEST,
        'This stream is made of several parts.',
      );
    case 'media-source':
      return new MediaGrabError(
        ErrorCode.UNSUPPORTED_MANIFEST,
        'The player assembles this in the page; there is no file to fetch.',
      );
    default:
      return new MediaGrabError(
        ErrorCode.UNSUPPORTED_MANIFEST,
        'This manifest lists nothing MediaGrab can download.',
      );
  }
}
