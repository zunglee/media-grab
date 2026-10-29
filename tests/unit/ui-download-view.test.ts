/**
 * The presentation rules behind a download row and the media list's warnings.
 */
import { describe, expect, it } from 'vitest';
import { DownloadState, type DownloadStrategy } from '../../src/core/download-types.ts';
import type { MediaVariant } from '../../src/core/types.ts';
import { isInFlight } from '../../src/downloads/state-machine.ts';
import { errorLines, offeredCommands, transferredLabel } from '../../src/ui/lib/download-view.ts';
import { lacksSound } from '../../src/ui/lib/media-view.ts';

const offered = (state: DownloadState, strategy: DownloadStrategy = 'browser-download') =>
  offeredCommands({ state, pausable: strategy === 'browser-download' });

describe('the commands a download row offers', () => {
  it('offers Pause and Cancel on a direct file the browser is fetching', () => {
    expect(offered(DownloadState.DOWNLOADING)).toEqual(['pause', 'cancel']);
    expect(offered(DownloadState.QUEUED)).toEqual(['pause', 'cancel']);
  });

  it('regression C10: offers only Cancel on a segmented download, whose pause would discard its bytes', () => {
    expect(offered(DownloadState.DOWNLOADING, 'segment-hls')).toEqual(['cancel']);
    expect(offered(DownloadState.QUEUED, 'segment-dash')).toEqual(['cancel']);
  });

  it('still offers Resume on a segmented task that is somehow paused', () => {
    expect(offered(DownloadState.PAUSED, 'segment-hls')).toEqual(['resume', 'cancel']);
  });

  it('follows the state machine for everything else', () => {
    expect(offered(DownloadState.FAILED, 'segment-dash')).toEqual(['retry', 'cancel']);
    expect(offered(DownloadState.VERIFYING, 'segment-hls')).toEqual(['cancel']);
    expect(offered(DownloadState.COMPLETED)).toEqual([]);
    expect(offered(DownloadState.CANCELLED)).toEqual([]);
  });
});

describe('what the Downloads tab counts', () => {
  it('counts tasks that move without the user, not those waiting for the user', () => {
    const counted = Object.values(DownloadState).filter(isInFlight);
    expect(counted.sort()).toEqual(['DOWNLOADING', 'QUEUED', 'RESUMING', 'VERIFYING']);
  });
});

describe('the size a download row shows', () => {
  it('regression C7: marks an estimated total with "~"', () => {
    expect(
      transferredLabel({
        receivedBytes: 10 * 1024 * 1024,
        totalBytes: 123 * 1024 * 1024,
        totalEstimated: true,
        speedBps: 0,
      }),
    ).toBe('10 MB / ~123 MB');
  });

  it('shows an exact total as exact, and no total when there is none', () => {
    expect(
      transferredLabel({ receivedBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, speedBps: 0 }),
    ).toBe('1.0 MB / 4.0 MB');
    expect(transferredLabel({ receivedBytes: 2048, speedBps: 0 })).toBe('2 KB');
  });
});

describe('the "no sound" warning', () => {
  const variant = (video: boolean, audio: boolean): MediaVariant => ({
    id: 'v',
    url: 'https://cdn.example/v.mpd',
    kind: video ? 'video' : 'audio',
    protocol: 'dash',
    format: 'mp4',
    tracks: { video, audio },
  });

  it('regression C9: applies to a rendition with a picture and no audio track', () => {
    expect(lacksSound(variant(true, false))).toBe(true);
  });

  it('does not apply to muxed video, to audio, or to a direct file with no rendition', () => {
    expect(lacksSound(variant(true, true))).toBe(false);
    expect(lacksSound(variant(false, true))).toBe(false);
    expect(lacksSound(undefined)).toBe(false);
  });
});

describe('a failed row says what happened, not only what kind of failure it was', () => {
  it('regression: shows the specific message under the plain headline', () => {
    expect(
      errorLines({
        code: 'UNSUPPORTED_MANIFEST',
        message:
          'This stream is made of 3 separate parts (often adverts), which MediaGrab cannot join into one file.',
      }),
    ).toEqual({
      headline: 'This stream format is not supported yet.',
      detail:
        'This stream is made of 3 separate parts (often adverts), which MediaGrab cannot join into one file.',
    });
  });

  it('D18: a row offering a grant says the host refused, not "reload the page"', () => {
    expect(errorLines({ code: 'STREAM_EXPIRED', message: 'HTTP 403' }, 'cdn.example')).toEqual({
      headline:
        'cdn.example refused MediaGrab. Allowing it lets MediaGrab say which page this is from.',
      detail: 'HTTP 403',
    });
  });

  it('does not repeat the headline', () => {
    expect(errorLines({ code: 'CANCELLED', message: 'Cancelled.' })).toEqual({
      headline: 'Cancelled.',
    });
  });
});
