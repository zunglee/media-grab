<script lang="ts">
  /**
   * The signal-strength meter. This is the identity element: every media row
   * carries one, so the list reads as a set of measurements rather than a stack
   * of cards. Five segments, filled in proportion to the candidate's score.
   */
  interface Props {
    /** 0-100 */
    value: number;
    label?: string;
  }

  const { value, label }: Props = $props();

  const segments = 5;
  const filled = $derived(Math.max(0, Math.min(segments, Math.round((value / 100) * segments))));
</script>

<div
  class="meter"
  role="meter"
  aria-valuenow={Math.round(value)}
  aria-valuemin="0"
  aria-valuemax="100"
  aria-label={label ?? `Detection confidence ${Math.round(value)} out of 100`}
>
  {#each Array.from({ length: segments }, (_unused, i) => i) as index (index)}
    <span class="seg" class:on={index < filled} class:weak={index < filled && filled <= 2}></span>
  {/each}
</div>

<style>
  .meter {
    /* Fills from the bottom, like a level meter, and sits at the top of the row
       so it lines up with the title rather than floating in the middle. */
    display: flex;
    flex-direction: column-reverse;
    gap: 2px;
    width: 5px;
    flex: none;
    align-self: flex-start;
    margin-top: 5px;
  }

  .seg {
    display: block;
    height: 7px;
    background: var(--meter-track);
    border-radius: 1px;
  }

  .seg.on {
    background: var(--meter-fill);
  }

  .seg.on.weak {
    background: var(--meter-weak);
  }
</style>
