<script lang="ts">
  /**
   * One task in the popup's Downloads view: name, state, progress, and the
   * commands its state offers (ui/lib/download-view.ts decides which).
   */
  import { DownloadState, type DownloadTaskView } from '../../core/download-types.ts';
  import type { DownloadCommand } from '../../core/messages.ts';
  import { formatEta, formatSpeed, fractionComplete } from '../../downloads/progress.ts';
  import { isActive } from '../../downloads/state-machine.ts';
  import {
    accessOffer,
    COMMAND_LABELS,
    errorLines,
    offeredCommands,
    transferredLabel,
  } from '../lib/download-view.ts';

  interface Props {
    task: DownloadTaskView;
    onCommand: (taskId: string, command: DownloadCommand) => void;
    /** Grant the host that refused, then retry (D18). Must run from this click. */
    onAllowHost?: (taskId: string, host: string) => void;
  }

  const { task, onCommand, onAllowHost }: Props = $props();

  // A finished file is whole even when the browser never reported its size.
  const percent = $derived(
    task.state === DownloadState.COMPLETED ? 100 : Math.round(fractionComplete(task.progress) * 100),
  );
  const name = $derived(task.filename.split('/').pop() ?? task.filename);
  const commands = $derived(offeredCommands(task));
  const allowHost = $derived(onAllowHost ? accessOffer(task) : undefined);
  const failure = $derived(task.error ? errorLines(task.error, allowHost) : undefined);
</script>

<article class="task">
  <div class="head">
    <span class="name" title={task.filename}>{name}</span>
    <span class="state label" data-state={task.state}>{task.state.toLowerCase()}</span>
  </div>

  <div
    class="bar"
    role="progressbar"
    aria-label={`Progress of ${name}`}
    aria-valuenow={percent}
    aria-valuemin="0"
    aria-valuemax="100"
  >
    <span class="fill" style:width={`${percent}%`}></span>
  </div>

  <div class="stats mono">
    <span>{transferredLabel(task.progress)}</span>
    {#if isActive(task.state)}
      <span>{formatSpeed(task.progress.speedBps)}</span>
      <span>ETA {formatEta(task.progress.etaSeconds)}</span>
    {/if}
    {#if task.progress.segmentsTotal}
      <span>{task.progress.segmentsDone ?? 0}/{task.progress.segmentsTotal} seg</span>
    {/if}
  </div>

  {#if failure}
    <p class="error">
      {failure.headline}
      {#if failure.detail}<span class="detail">{failure.detail}</span>{/if}
    </p>
  {/if}

  <!-- Every row has a "Cancel"; the file name in each label tells them apart. -->
  <div class="actions">
    {#if allowHost}
      <button
        class="quiet"
        aria-label={`Allow ${allowHost} and retry ${name}`}
        onclick={() => onAllowHost?.(task.id, allowHost)}
      >
        Allow {allowHost} and retry
      </button>
    {/if}
    {#each commands as command (command)}
      <button
        class="quiet"
        aria-label={`${COMMAND_LABELS[command]} ${name}`}
        onclick={() => onCommand(task.id, command)}
      >
        {COMMAND_LABELS[command]}
      </button>
    {/each}
  </div>
</article>

<style>
  .task {
    padding: var(--s3) var(--s4);
    border-bottom: 1px solid var(--rule);
  }

  .head {
    display: flex;
    justify-content: space-between;
    gap: var(--s2);
    align-items: baseline;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state[data-state='COMPLETED'] {
    color: var(--ok);
  }
  .state[data-state='FAILED'] {
    color: var(--danger);
  }
  .state[data-state='DOWNLOADING'],
  .state[data-state='VERIFYING'] {
    color: var(--signal);
  }

  .bar {
    margin: var(--s2) 0 var(--s1);
    height: 3px;
    background: var(--meter-track);
    border-radius: 1px;
    overflow: hidden;
  }

  .fill {
    display: block;
    height: 100%;
    background: var(--meter-fill);
    transition: width var(--duration) var(--ease);
  }

  .stats {
    display: flex;
    gap: var(--s3);
    font-size: var(--text-xs);
    color: var(--ink-faint);
  }

  .error {
    margin: var(--s2) 0 0;
    font-size: var(--text-sm);
    color: var(--danger);
  }

  .error .detail {
    display: block;
    margin-top: var(--s1);
    font-size: var(--text-xs);
    color: var(--ink-muted);
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    gap: var(--s1);
    margin-top: var(--s2);
  }
</style>
