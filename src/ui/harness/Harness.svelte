<script lang="ts">
  /**
   * Development harness. Renders the popup at its real width, in each of the
   * states that are awkward to reach in a browser, plus the options page.
   * Each popup runs its real controller against a fixture bridge.
   * Not shipped: it is excluded from every extension build.
   */
  import Options from '../options/Options.svelte';
  import Popup from '../popup/Popup.svelte';
  import { fixtureBridge } from './fixture-bridge.ts';
  import {
    downloadsFixture,
    emptyScanFixture,
    protectedOnlyScanFixture,
    scanFixture,
    videoOnlyScanFixture,
  } from './fixtures.ts';

  const states = [
    {
      id: 'with-media',
      label: 'Media detected',
      bridge: fixtureBridge({ stored: scanFixture, downloads: downloadsFixture }),
    },
    { id: 'no-media', label: 'Nothing found (diagnosis)', bridge: fixtureBridge({ stored: emptyScanFixture }) },
    { id: 'video-only', label: 'Video and audio in separate tracks', bridge: fixtureBridge({ stored: videoOnlyScanFixture }) },
    { id: 'protected-only', label: 'Only protected media', bridge: fixtureBridge({ stored: protectedOnlyScanFixture }) },
    { id: 'needs-access', label: 'Site not enabled yet', bridge: fixtureBridge({ granted: false, scans: [scanFixture] }) },
    { id: 'scan-failed', label: 'Scan did not finish', bridge: fixtureBridge({ scans: [undefined, scanFixture] }) },
  ];
</script>

<h1>MediaGrab UI harness</h1>
<p class="note">Fixtures only. No extension APIs, no network.</p>

<div class="frames">
  {#each states as state (state.id)}
    <section>
      <h2 class="label">{state.label}</h2>
      <div class="popup-frame" data-testid={state.id}>
        <Popup bridge={state.bridge} />
      </div>
    </section>
  {/each}
</div>

<section class="options-frame">
  <h2 class="label">Options page</h2>
  <Options />
</section>

<style>
  h1 {
    font-size: 20px;
    margin: var(--s5) var(--s5) var(--s1);
  }

  .note {
    margin: 0 var(--s5) var(--s5);
    color: var(--ink-muted);
  }

  .frames {
    display: flex;
    gap: var(--s6);
    flex-wrap: wrap;
    padding: 0 var(--s5) var(--s6);
  }

  .popup-frame {
    width: 384px;
    border: 1px solid var(--rule-strong);
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--ground);
  }

  h2 {
    margin-bottom: var(--s2);
  }

  .options-frame {
    border-top: 1px solid var(--rule);
    padding: var(--s6) var(--s5);
  }
</style>
