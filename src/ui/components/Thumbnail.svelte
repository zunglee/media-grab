<script lang="ts">
  /**
   * The preview beside each media row.
   *
   * Three states, because a missing or broken poster must not read as a broken
   * extension: the picture, a labelled placeholder carrying the container name,
   * and the same placeholder after a load error. The frame is the same size in
   * all three so the list never reflows.
   *
   * Privacy: this is a remote image loaded from an extension page. `no-referrer`
   * keeps the CDN from learning that the request came from the extension rather
   * than the page, and `lazy` means a row scrolled out of view is never fetched.
   * The page itself already loaded this image, so nothing new is disclosed.
   * Decorative by design - the row's heading already names the media, so an alt
   * text here would be read out twice.
   */
  import type { MediaKind } from '../../core/types.ts';

  interface Props {
    src?: string | undefined;
    /** Shown when there is no picture: 'MP4', 'HLS', 'MP3'. */
    label: string;
    kind: MediaKind;
  }

  const { src, label, kind }: Props = $props();

  // Remembers which picture failed, not just that one did: a row whose poster
  // changes (a later scan found a better one) gets to try the new one.
  let failedSrc = $state<string | undefined>();
  const showImage = $derived(Boolean(src) && src !== failedSrc);

  const glyph = $derived(kind === 'audio' ? '♪' : kind === 'subtitle' ? 'CC' : '▶');
</script>

<div class="thumb" class:empty={!showImage} aria-hidden="true">
  {#if showImage}
    <img
      {src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      onerror={() => {
        failedSrc = src;
      }}
    />
  {:else}
    <span class="glyph">{glyph}</span>
    <span class="label">{label}</span>
  {/if}
</div>

<style>
  .thumb {
    /* 16:9 at the width the 384px popup can spare. */
    width: 76px;
    height: 43px;
    flex: none;
    position: relative;
    overflow: hidden;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--ground-sunken);
  }

  .thumb.empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* --ink-faint is tuned against --ground and only reaches 4.24:1 on the sunken
     ground this placeholder sits on. --ink-muted clears 4.5:1 in both themes. */
  .glyph {
    color: var(--ink-muted);
    font-size: 13px;
    line-height: 1;
  }

  .label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: var(--tracking-label);
    color: var(--ink-muted);
    text-transform: uppercase;
  }
</style>
