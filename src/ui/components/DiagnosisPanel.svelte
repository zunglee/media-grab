<script lang="ts">
  import type { Diagnosis } from '../../core/types.ts';
  import { DIAGNOSIS_TITLES } from '../../detection/diagnose.ts';

  interface Props {
    diagnosis: Diagnosis;
    onRescan: () => void;
    onReport: () => void;
  }

  const { diagnosis, onRescan, onReport }: Props = $props();
</script>

<section class="panel">
  <h2>{DIAGNOSIS_TITLES[diagnosis.code]}</h2>
  <p class="code label">{diagnosis.code}</p>
  <ul>
    {#each diagnosis.reasons as reason (reason)}
      <li>{reason}</li>
    {/each}
  </ul>
  <div class="actions">
    <button class="primary" onclick={onRescan}>Scan again</button>
    <button class="quiet" onclick={onReport}>Report this site</button>
  </div>
</section>

<style>
  .panel {
    padding: var(--s5) var(--s4);
  }

  h2 {
    font-size: var(--text-md);
  }

  .code {
    margin: var(--s1) 0 var(--s3);
  }

  ul {
    margin: 0 0 var(--s4);
    padding-left: var(--s4);
    color: var(--ink-muted);
    font-size: var(--text-sm);
  }

  li + li {
    margin-top: var(--s1);
  }

  .actions {
    display: flex;
    gap: var(--s2);
  }
</style>
