<script lang="ts">
  /**
   * The popup. Two views, one decision each:
   *   MEDIA     - what is on this page, and the one button that takes the best of it
   *   DOWNLOADS - what is in flight
   *
   * The primary action is always "download the best version". Quality ladders,
   * codecs and manifests exist behind a disclosure, because a person who wants
   * a video should not have to know what a bitrate is (PRD s57, s58).
   *
   * This file only draws. What happens on open and on every click lives in
   * ui/lib/popup-controller.ts; `bridge` is how that logic reaches the worker
   * (the extension's, or the dev harness's fixtures).
   */
  import { onMount, untrack } from 'svelte';
  import { pickBestDownload } from '../../media/quality.ts';
  import { originPatternFor } from '../../permissions/site-access.ts';
  import DiagnosisPanel from '../components/DiagnosisPanel.svelte';
  import DownloadRow from '../components/DownloadRow.svelte';
  import MediaRow from '../components/MediaRow.svelte';
  import type { PopupBridge } from '../lib/bridge.ts';
  import { isInFlight } from '../../downloads/state-machine.ts';
  import { nothingSaveableHint, soundNote } from '../lib/media-view.ts';
  import { PopupController, type PopupState } from '../lib/popup-controller.ts';

  interface Props {
    bridge: PopupBridge;
  }

  const { bridge }: Props = $props();

  // The bridge is read once: one popup, one controller, for its whole life.
  const controller = new PopupController(
    untrack(() => bridge),
    (next) => {
      ui = next;
    },
  );
  let ui = $state.raw<PopupState>(controller.state);

  onMount(() => {
    void controller.start();
    return () => controller.stop();
  });

  const candidates = $derived(ui.scan?.candidates ?? []);
  const best = $derived(pickBestDownload(candidates));
  const inFlight = $derived(ui.downloads.filter((task) => isInFlight(task.state)).length);
  const scanning = $derived(ui.scanStatus !== 'idle');
  const bestHintId = $props.id();

  /**
   * Why the Best download button cannot be taken, or what it will save: the
   * video and its audio as two files, or a video with no sound at all.
   */
  const bestHint = $derived(!best ? nothingSaveableHint(candidates) : soundNote(best));

  /** What the media view says when there is nothing to show and nothing running. */
  const stalled = $derived(
    ui.tabId === undefined ? 'MediaGrab could not tell which page this popup belongs to.'
    : !ui.scan ? 'MediaGrab could not scan this page.'
    : 'No media found on this page yet.',
  );
</script>

<header>
  <div class="brand">
    <span class="wordmark">MediaGrab</span>
    <span class="count label">
      {#if scanning}
        scanning
      {:else}
        {candidates.length} detected
      {/if}
    </span>
  </div>

  <nav class="views" aria-label="Views">
    <button
      class="quiet"
      class:on={ui.view === 'media'}
      aria-pressed={ui.view === 'media'}
      onclick={() => controller.showView('media')}
    >
      Media
    </button>
    <button
      class="quiet"
      class:on={ui.view === 'downloads'}
      aria-pressed={ui.view === 'downloads'}
      onclick={() => controller.showView('downloads')}
    >
      Downloads{inFlight > 0 ? ` (${inFlight})` : ''}
    </button>
  </nav>
</header>

<hr class="rule" />

{#if ui.notice}
  <p class="notice" role="status">{ui.notice}</p>
{/if}

<main>
  {#if ui.view === 'media'}
    {#if ui.access === 'unsupported'}
      <p class="empty">MediaGrab cannot run on this kind of page.</p>
    {:else if ui.access === 'needed'}
      <section class="permission">
        <h2>Enable MediaGrab on this site</h2>
        <p>
          MediaGrab asks for one site at a time instead of every site you visit. It needs access to
          <span class="mono">{originPatternFor(ui.pageUrl) ?? ui.pageUrl}</span> to watch that page's media requests.
        </p>
        <button class="primary" onclick={() => controller.grantAccess()}>Enable on this site</button>
      </section>
    {:else if candidates.length > 0}
      <div class="bestbar">
        <div class="bestactions">
          <button
            class="primary best"
            disabled={ui.busy || !best}
            aria-describedby={bestHint ? bestHintId : undefined}
            onclick={() => controller.downloadBest()}
          >
            Best download
          </button>
          <button class="quiet" disabled={scanning} onclick={() => controller.rescan()}>Scan again</button>
        </div>
        {#if bestHint}
          <p class="besthint" id={bestHintId}>{bestHint}</p>
        {/if}
      </div>
      <ul class="list">
        {#each candidates as candidate (candidate.id)}
          <li>
            <MediaRow
              {candidate}
              powerMode={ui.powerMode}
              busy={ui.busy}
              onDownload={(chosen, variant, audio) => controller.download(chosen, variant, audio)}
            />
          </li>
        {/each}
      </ul>
    {:else if ui.scan?.diagnosis}
      <DiagnosisPanel
        diagnosis={ui.scan.diagnosis}
        onRescan={() => controller.rescan()}
        onReport={() => controller.copyReport()}
      />
    {:else if scanning}
      <p class="empty">Scanning this page…</p>
    {:else}
      <section class="stalled">
        <p>{stalled}</p>
        <button class="primary" onclick={() => controller.rescan()}>Scan again</button>
      </section>
    {/if}
  {:else if ui.downloads.length > 0}
    <ul class="list">
      {#each ui.downloads as task (task.id)}
        <li>
          <DownloadRow
            {task}
            onCommand={(taskId, command) => controller.command(taskId, command)}
            onAllowHost={(taskId, host) => controller.allowHostAndRetry(taskId, host)}
          />
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">No downloads yet.</p>
  {/if}
</main>

<hr class="rule" />

<footer>
  <button class="quiet" onclick={() => controller.openSettings()}>Settings</button>
  {#if ui.powerMode && ui.scan}
    <span class="label mono">
      {ui.scan.stats.networkRequestsObserved} req · {ui.scan.stats.manifestsParsed} manifests · {ui.scan.rejected.length} filtered
    </span>
  {/if}
</footer>

<style>
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--s3) var(--s4) var(--s2);
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    min-width: 0;
  }

  .wordmark {
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .views {
    display: flex;
    gap: var(--s1);
  }

  .views .on {
    color: var(--ink);
    border-color: var(--rule-strong);
  }

  main {
    max-height: 452px;
    overflow-y: auto;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .bestbar {
    padding: var(--s3) var(--s4);
    border-bottom: 1px solid var(--rule);
    background: var(--ground-sunken);
  }

  .bestactions {
    display: flex;
    gap: var(--s2);
  }

  /* Full ink rather than --warn: --warn only reaches 4.4:1 on the sunken bar. */
  .besthint {
    margin: var(--s2) 0 0;
    font-size: var(--text-sm);
    color: var(--ink);
  }

  .best {
    flex: 1;
  }

  .empty,
  .notice {
    padding: var(--s5) var(--s4);
    margin: 0;
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }

  .notice {
    padding: var(--s2) var(--s4);
    color: var(--signal);
    border-bottom: 1px solid var(--rule);
  }

  .permission,
  .stalled {
    padding: var(--s5) var(--s4);
  }

  .stalled p {
    margin: 0 0 var(--s3);
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }

  .permission h2 {
    font-size: var(--text-md);
    margin-bottom: var(--s2);
  }

  .permission p {
    margin: 0 0 var(--s4);
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s2);
    padding: var(--s2) var(--s4);
  }
</style>
