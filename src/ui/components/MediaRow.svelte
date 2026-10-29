<script lang="ts">
  /**
   * One detected media. Its main button downloads what "best" means for it
   * (D20) - with the separate audio track as a second file when the stream is
   * split - and the disclosure lists every rendition. What cannot be saved is
   * still shown, disabled, with the one-line reason (D21): the whole row, or
   * one rendition of the ladder.
   */
  import type { MediaCandidate, MediaVariant } from '../../core/types.ts';
  import {
    bestVariantOf,
    formatBytes,
    formatDuration,
    qualityLabel,
    recommend,
    resolutionLabel,
  } from '../../media/quality.ts';
  import { renditionSaveability, saveabilityOf } from '../../media/saveability.ts';
  import {
    lacksSound,
    mainDownloadBlock,
    NO_SOUND,
    soundNote,
    unsaveableReason,
  } from '../lib/media-view.ts';
  import Meter from './Meter.svelte';
  import Thumbnail from './Thumbnail.svelte';

  interface Props {
    candidate: MediaCandidate;
    powerMode: boolean;
    busy: boolean;
    onDownload: (candidate: MediaCandidate, variant?: MediaVariant, audio?: MediaVariant) => void;
  }

  const { candidate, powerMode, busy, onDownload }: Props = $props();

  const recommendations = $derived(recommend(candidate));
  const best = $derived(recommendations[0]);
  // Every rendition, then the separate audio tracks: an audio track's own
  // download is how the user gets the sound of any other rendition.
  const ladder = $derived.by(() => {
    const variants = candidate.variants ?? [];
    const listed = new Set(variants.map((variant) => variant.id));
    return [...variants, ...(candidate.audioTracks ?? []).filter((track) => !listed.has(track.id))];
  });
  let expanded = $state(false);
  const blocked = $derived(unsaveableReason(saveabilityOf(candidate)));
  // The row can be saved, yet "best" found nothing in its ladder to take: the
  // main button is disabled and says why, rather than failing on click. The
  // ladder stays open - a rendition "best" never picks may still be saveable.
  const mainBlocked = $derived(mainDownloadBlock(candidate, best));
  const note = $derived(mainBlocked ?? soundNote(best));
  const rowId = $props.id();

  const subtitle = $derived.by(() => {
    const parts: string[] = [];
    const protocolLabel =
      candidate.protocol === 'hls' ? 'HLS' : candidate.protocol === 'dash' ? 'DASH' : candidate.format.toUpperCase();
    parts.push(protocolLabel);
    // A row that cannot be saved still says what it is: its top rendition.
    const top = best?.variant ?? bestVariantOf(candidate);
    const quality = top
      ? qualityLabel(top)
      : candidate.resolution
        ? resolutionLabel(candidate.resolution, candidate.fps)
        : null;
    if (quality) parts.push(quality);
    if (candidate.duration !== undefined) parts.push(formatDuration(candidate.duration));
    const size = best?.sizeBytes ?? candidate.sizeBytes;
    if (size !== undefined) parts.push(formatBytes(size, best?.sizeEstimated ?? candidate.sizeEstimated === true));
    return parts.join('  ·  ');
  });

  const title = $derived(candidate.title || candidate.pageTitle || 'Untitled media');

  /** Container name for the placeholder, when there is no poster to show. */
  const formatLabel = $derived(
    candidate.protocol === 'hls'
      ? 'HLS'
      : candidate.protocol === 'dash'
        ? 'DASH'
        : candidate.format === 'unknown'
          ? candidate.kind
          : candidate.format,
  );
</script>

<article class="row" class:unsaveable={blocked !== null}>
  <Meter value={candidate.score ?? 0} label={`Confidence for ${title}`} />

  <Thumbnail src={candidate.posterUrl} label={formatLabel} kind={candidate.kind} />

  <div class="body">
    <div class="head">
      <h3 class="title" title={title}>{title}</h3>
      {#if candidate.live}
        <span class="live label">Live</span>
      {/if}
    </div>

    <p class="meta mono">{subtitle}</p>

    {#if blocked}
      <p class="blocked">{blocked}</p>
    {:else}
      <div class="actions">
        <button
          class="primary"
          disabled={busy || mainBlocked !== null}
          aria-describedby={note ? rowId : undefined}
          onclick={() => onDownload(candidate, best?.variant, best?.audio)}
        >
          {best ? `Download ${qualityLabel(best.variant)}` : 'Download'}
        </button>
        {#if note}
          <span class="nosound" id={rowId}>{note}</span>
        {/if}

        {#if ladder.length > 1}
          <button
            class="quiet"
            aria-expanded={expanded}
            onclick={() => {
              expanded = !expanded;
            }}
          >
            {expanded
              ? 'Hide qualities'
              : `${ladder.length} ${ladder.some((v) => v.kind === 'audio' && !v.tracks.video) && (candidate.variants ?? []).some((v) => v.tracks.video) ? 'downloads' : 'qualities'}`}
          </button>
        {/if}
      </div>

      {#if expanded}
        <ul class="ladder">
          {#each ladder as variant, index (variant.id)}
            {@const whyNot = unsaveableReason(renditionSaveability(candidate, variant))}
            <li>
              <button
                class="quiet variant"
                disabled={busy || whyNot !== null}
                aria-describedby={whyNot ? `${rowId}-${index}` : undefined}
                onclick={() => onDownload(candidate, variant)}
              >
                <span class="mono q">{qualityLabel(variant)}</span>
                <span class="mono detail">
                  {variant.bandwidth ? `${(variant.bandwidth / 1_000_000).toFixed(1)} Mbps` : ''}
                  {#if powerMode && variant.codecs?.length}
                    <span class="codec">{variant.codecs.join(', ')}</span>
                  {/if}
                  {#if lacksSound(variant)}<span class="codec">{NO_SOUND}</span>{/if}
                </span>
              </button>
              <!-- Outside the button: a disabled button is dimmed, and the reason is what the reader needs. -->
              {#if whyNot}
                <p class="whynot" id={`${rowId}-${index}`}>{whyNot}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if powerMode && candidate.scoreReasons?.length}
        <details class="why">
          <summary class="label">Score {candidate.score}</summary>
          <ul>
            {#each candidate.scoreReasons as reason (reason)}
              <li class="mono">{reason}</li>
            {/each}
          </ul>
        </details>
      {/if}
    {/if}
  </div>
</article>

<style>
  .row {
    display: flex;
    gap: var(--s3);
    padding: var(--s3) var(--s4);
    border-bottom: 1px solid var(--rule);
    align-items: stretch;
  }

  /*
   * A row that cannot be saved is de-emphasised by muting the title only.
   * Dimming the whole row with opacity drops the explanation below 4.5:1, and
   * the explanation is the one part of that row the reader actually needs.
   */
  .row.unsaveable .title {
    color: var(--ink-muted);
  }

  .body {
    min-width: 0;
    flex: 1;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
  }

  .title {
    font-size: var(--text-md);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .live {
    color: var(--live);
    border: 1px solid currentColor;
    border-radius: 2px;
    padding: 0 3px;
    flex: none;
  }

  .meta {
    margin: 2px 0 var(--s2);
    font-size: var(--text-sm);
    color: var(--ink-muted);
  }

  .blocked {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--warn);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
    align-items: center;
  }

  .nosound {
    font-size: var(--text-sm);
    color: var(--warn);
  }

  .whynot {
    margin: 0 0 var(--s1);
    padding: 0 var(--s2);
    font-size: var(--text-xs);
    color: var(--warn);
  }

  .ladder {
    list-style: none;
    margin: var(--s2) 0 0;
    padding: 0;
    border-top: 1px solid var(--rule);
  }

  .variant {
    display: flex;
    justify-content: space-between;
    width: 100%;
    gap: var(--s3);
    padding: var(--s1) var(--s2);
    text-align: left;
  }

  .q {
    font-weight: 600;
  }

  .detail {
    color: var(--ink-faint);
    font-size: var(--text-sm);
    display: flex;
    gap: var(--s2);
  }

  .codec {
    color: var(--ink-faint);
  }

  .why {
    margin-top: var(--s2);
  }

  .why ul {
    margin: var(--s1) 0 0;
    padding-left: var(--s4);
    color: var(--ink-faint);
    font-size: var(--text-xs);
  }

  summary {
    cursor: pointer;
  }
</style>
