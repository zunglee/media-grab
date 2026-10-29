<script lang="ts">
  /**
   * Settings. Grouped exactly as PRD s47 specifies, with one addition: the
   * permission section, because "which sites can this extension read" is the
   * setting people actually care about and it is usually buried in the browser.
   *
   * Every change is saved at once (storage/settings.ts) and the worker is told
   * to reload; the form then shows what was saved, which may be a corrected value.
   */
  import { DEFAULT_TEMPLATE } from '../../media/naming.ts';
  import { hasAllSitesAccess, requestAllSitesAccess } from '../../permissions/site-access.ts';
  import { clearHistory, groupByDay, loadHistory, type HistoryEntry } from '../../storage/history.ts';
  import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../../storage/settings.ts';
  import { notifySettingsChanged } from '../lib/bridge.ts';

  type AllSites = 'unknown' | 'granted' | 'not-granted' | 'declined';

  const ALL_SITES_STATUS: Record<AllSites, string> = {
    unknown: '',
    granted: 'Allowed on all sites.',
    'not-granted': 'Not allowed. MediaGrab asks one site at a time.',
    declined: 'Not allowed. The browser request was declined.',
  };

  let settings = $state<Settings>(structuredClone(DEFAULT_SETTINGS));
  let history = $state<HistoryEntry[]>([]);
  let allSites = $state<AllSites>('unknown');
  let saved = $state(false);

  const historyGroups = $derived(groupByDay(history));

  $effect(() => {
    void (async () => {
      settings = await loadSettings();
      history = await loadHistory();
      allSites = (await hasAllSitesAccess()) ? 'granted' : 'not-granted';
    })();
  });

  async function persist(): Promise<void> {
    settings = await saveSettings($state.snapshot(settings));
    await notifySettingsChanged();
    saved = true;
    setTimeout(() => {
      saved = false;
    }, 1600);
  }

  /** From the click itself: the browser only shows its prompt during the gesture. */
  async function grantAll(): Promise<void> {
    allSites = (await requestAllSitesAccess()) ? 'granted' : 'declined';
  }

  async function wipeHistory(): Promise<void> {
    await clearHistory();
    history = [];
  }
</script>

<header>
  <h1>MediaGrab</h1>
  <p class="lede">
    Detects downloadable media on the page you are on. It does not remove DRM, bypass paywalls, or sign in for you.
  </p>
</header>

<section>
  <h2>Site access</h2>
  <p class="hint">
    MediaGrab ships with no site permissions. It asks for one site at a time from the popup. You can grant every site
    here if you would rather not be asked.
  </p>
  <div class="row">
    {#if allSites !== 'granted'}
      <button onclick={grantAll}>Allow on all sites</button>
    {/if}
    <span class="status" role="status">{ALL_SITES_STATUS[allSites]}</span>
  </div>
  <p class="hint">To revoke this, use your browser's extension settings.</p>
</section>

<section>
  <h2>General</h2>
  <label class="row">
    <span>Interface</span>
    <select bind:value={settings.general.mode} onchange={persist}>
      <option value="simple">Simple - best download and quality names</option>
      <option value="power">Power - codecs, bitrates, scores, manifests</option>
    </select>
  </label>
  <label class="row">
    <input type="checkbox" bind:checked={settings.general.autoScan} onchange={persist} />
    <span>Scan automatically as media appears</span>
  </label>
  <label class="row">
    <input type="checkbox" bind:checked={settings.general.notifications} onchange={persist} />
    <span>Notify me when a download finishes</span>
  </label>
</section>

<section>
  <h2>Downloads</h2>
  <label class="row">
    <span>Concurrent downloads</span>
    <input type="number" min="1" max="8" bind:value={settings.downloads.concurrentDownloads} onchange={persist} />
  </label>
  <label class="row">
    <span>Parallel segments (0 = automatic)</span>
    <input type="number" min="0" max="8" bind:value={settings.downloads.segmentConcurrency} onchange={persist} />
  </label>
  <label class="row">
    <span>Retries per download</span>
    <input type="number" min="0" max="10" bind:value={settings.downloads.retryCount} onchange={persist} />
  </label>
  <label class="row wide">
    <span>Filename template</span>
    <input type="text" bind:value={settings.downloads.namingTemplate} onchange={persist} />
  </label>
  <p class="hint mono">
    {'{title} {domain} {date} {time} {quality} {resolution} {format} {codec} {language} {index} {ext}'}
  </p>
  <p class="hint">Default: <span class="mono">{DEFAULT_TEMPLATE}</span></p>
  <label class="row wide">
    <span>Folder inside your downloads directory</span>
    <input type="text" bind:value={settings.downloads.baseFolder} onchange={persist} />
  </label>
  <label class="row">
    <input type="checkbox" bind:checked={settings.downloads.siteFolders} onchange={persist} />
    <span>Create a folder per site</span>
  </label>
  <label class="row">
    <input type="checkbox" bind:checked={settings.downloads.dateFolders} onchange={persist} />
    <span>Create a folder per date</span>
  </label>
  <label class="row">
    <input type="checkbox" bind:checked={settings.downloads.askWhereToSave} onchange={persist} />
    <span>Ask where to save every file</span>
  </label>
</section>

<section>
  <h2>Privacy</h2>
  <p class="hint">
    MediaGrab has no backend. No page URL, no media URL and no media file leaves this machine. Diagnostics are copied to
    your clipboard for you to read and share yourself.
  </p>
  <label class="row">
    <input type="checkbox" bind:checked={settings.privacy.keepHistory} onchange={persist} />
    <span>Keep a local download history</span>
  </label>
  <label class="row">
    <span>History entries to keep</span>
    <input type="number" min="0" max="2000" bind:value={settings.privacy.historyLimit} onchange={persist} />
  </label>
  <label class="row">
    <input type="checkbox" bind:checked={settings.advanced.debugLogging} onchange={persist} />
    <span>Debug logging (writes full URLs to the console)</span>
  </label>
</section>

<section>
  <h2>History</h2>
  {#if history.length === 0}
    <p class="hint">Nothing downloaded yet.</p>
  {:else}
    {#each historyGroups as group (group.label)}
      <h3 class="label">{group.label}</h3>
      <ul class="history">
        {#each group.entries as entry (entry.id)}
          <li>
            <span class="name">{entry.filename.split('/').pop()}</span>
            <span class="mono meta">{entry.domain}</span>
          </li>
        {/each}
      </ul>
    {/each}
    <button onclick={wipeHistory}>Clear history</button>
  {/if}
</section>

{#if saved}
  <p class="saved" role="status">Saved</p>
{/if}

<style>
  header {
    margin-bottom: var(--s8);
  }

  h1 {
    font-size: 24px;
    letter-spacing: -0.02em;
  }

  .lede {
    color: var(--ink-muted);
    margin: var(--s2) 0 0;
    max-width: 56ch;
  }

  section {
    padding: var(--s5) 0;
    border-top: 1px solid var(--rule);
  }

  h2 {
    font-size: var(--text-md);
    margin-bottom: var(--s3);
  }

  h3 {
    margin: var(--s3) 0 var(--s1);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: var(--s1) 0;
  }

  .row.wide {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--s1);
  }

  .row span {
    min-width: 220px;
  }

  .row.wide span {
    min-width: 0;
  }

  .hint {
    color: var(--ink-faint);
    font-size: var(--text-sm);
    margin: var(--s1) 0 var(--s3);
    max-width: 62ch;
  }

  .history {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .history li {
    display: flex;
    justify-content: space-between;
    gap: var(--s3);
    padding: var(--s1) 0;
    border-bottom: 1px solid var(--rule);
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    color: var(--ink-faint);
    font-size: var(--text-sm);
    flex: none;
  }

  .saved {
    position: fixed;
    right: var(--s5);
    bottom: var(--s5);
    background: var(--ok);
    color: var(--ground);
    padding: var(--s1) var(--s3);
    border-radius: var(--radius);
  }
</style>
