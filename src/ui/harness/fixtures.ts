/**
 * Fixture data for the dev harness and the UI tests.
 *
 * Built by running the real intelligence layer over hand-written candidates,
 * so what the harness renders is what the engine would actually produce -
 * including the scores, the ladder ordering, the recommendations and what can
 * be saved (`decided`, from what each manifest would have said).
 */
import { DownloadState, type DownloadTaskView } from '../../core/download-types.ts';
import type { MediaCandidate, MediaVariant, ScanResult } from '../../core/types.ts';
import type { StreamFacts } from '../../detection/manifest-loader.ts';
import { assessSaveability } from '../../detection/saveability.ts';
import { hashString } from '../../media/fingerprint.ts';
import { qualityScore, rank } from '../../media/score.ts';

const PAGE_URL = 'https://example.test/talks/how-to-build-a-startup';
const PAGE_TITLE = 'How to Build a Startup';
/** Served by the harness dev server; stands in for a real poster frame. */
const POSTER = '/poster.svg';

/** What the scan decides about a candidate (D21), given what its manifest said. */
function decided(candidate: MediaCandidate, facts?: StreamFacts): MediaCandidate {
  return assessSaveability(candidate, facts);
}

/** A media playlist the scan probed: clear, finished, this many segments. */
function probed(segmentCount: number, encrypted = false): StreamFacts {
  return { document: 'hls-media', encrypted, iframesOnly: false, segmentCount, container: 'ts' };
}

function hlsVariant(
  height: number,
  bandwidth: number,
  codecs: string[],
  base = 'https://cdn.example.test/hls',
): MediaVariant {
  const variant: MediaVariant = {
    id: hashString(`${base}/v${height}`),
    url: `${base}/${height}/index.m3u8`,
    kind: 'video',
    protocol: 'hls',
    format: 'ts',
    bandwidth,
    resolution: { width: Math.round((height * 16) / 9), height },
    fps: height >= 1080 ? 30 : 30,
    codecs,
    tracks: { video: true, audio: true },
  };
  variant.score = qualityScore({ height, bitrate: bandwidth, codecs });
  return variant;
}

const stream: MediaCandidate = {
  id: 'fixture-hls',
  url: 'https://cdn.example.test/hls/master.m3u8',
  pageUrl: PAGE_URL,
  pageTitle: PAGE_TITLE,
  title: PAGE_TITLE,
  kind: 'video',
  protocol: 'hls',
  format: 'ts',
  source: 'network',
  seenAt: Date.now() - 4_000,
  duration: 1_842,
  posterUrl: POSTER,
  tracks: { video: true, audio: true },
  variants: [
    hlsVariant(2160, 16_000_000, ['hvc1.1.6.L150', 'mp4a.40.2']),
    hlsVariant(1080, 5_200_000, ['avc1.640028', 'mp4a.40.2']),
    hlsVariant(720, 3_100_000, ['avc1.4d401f', 'mp4a.40.2']),
    hlsVariant(480, 1_500_000, ['avc1.4d401e', 'mp4a.40.2']),
  ],
  subtitles: [
    {
      id: 's-en',
      url: 'https://cdn.example.test/subs/en.vtt',
      format: 'vtt',
      language: 'en',
      label: 'English',
    },
  ],
};

/**
 * A clear ladder whose segments are AES-128 encrypted: the master says
 * nothing, the probed rendition does, and the row says why it cannot be saved.
 */
const encryptedStream: MediaCandidate = {
  id: 'fixture-hls-aes',
  url: 'https://cdn.example.test/members/master.m3u8',
  pageUrl: PAGE_URL,
  pageTitle: PAGE_TITLE,
  title: 'Members-only replay',
  kind: 'video',
  protocol: 'hls',
  format: 'ts',
  source: 'network',
  seenAt: Date.now() - 3_000,
  tracks: { video: true, audio: true },
  variants: [
    hlsVariant(1080, 5_000_000, ['avc1.640028', 'mp4a.40.2'], 'https://cdn.example.test/members'),
    hlsVariant(720, 2_800_000, ['avc1.4d401f', 'mp4a.40.2'], 'https://cdn.example.test/members'),
  ],
};

const liveStream: MediaCandidate = {
  id: 'fixture-hls-live',
  url: 'https://cdn.example.test/live/master.m3u8',
  pageUrl: PAGE_URL,
  pageTitle: PAGE_TITLE,
  title: 'Studio camera',
  kind: 'video',
  protocol: 'hls',
  format: 'ts',
  source: 'network',
  seenAt: Date.now() - 500,
  live: true,
  tracks: { video: true, audio: true },
  variants: [
    hlsVariant(720, 3_000_000, ['avc1.4d401f', 'mp4a.40.2'], 'https://cdn.example.test/live'),
  ],
};

const progressive: MediaCandidate = {
  id: 'fixture-mp4',
  url: 'https://cdn.example.test/files/interview.mp4',
  pageUrl: PAGE_URL,
  pageTitle: PAGE_TITLE,
  title: 'Backstage interview',
  kind: 'video',
  protocol: 'progressive',
  format: 'mp4',
  source: 'dom-element',
  seenAt: Date.now() - 2_000,
  duration: 372,
  resolution: { width: 1280, height: 720 },
  posterUrl: POSTER,
  sizeBytes: 148_000_000,
  sizeEstimated: false,
  tracks: { video: true, audio: true },
};

const podcast: MediaCandidate = {
  id: 'fixture-mp3',
  url: 'https://cdn.example.test/audio/episode-14.mp3',
  pageUrl: PAGE_URL,
  pageTitle: PAGE_TITLE,
  title: 'Episode 14 - Scaling teams',
  kind: 'audio',
  protocol: 'progressive',
  format: 'mp3',
  source: 'network',
  seenAt: Date.now() - 1_000,
  duration: 2_760,
  sizeBytes: 66_000_000,
  sizeEstimated: false,
  bitrate: 192_000,
  tracks: { video: false, audio: true },
};

const protectedStream: MediaCandidate = {
  id: 'fixture-drm',
  url: 'https://cdn.example.test/dash/protected.mpd',
  pageUrl: PAGE_URL,
  pageTitle: PAGE_TITLE,
  title: 'Feature film (protected)',
  // Left without a poster on purpose: the placeholder state has to be visible
  // in the harness too, not only in theory.
  kind: 'video',
  protocol: 'dash',
  format: 'mp4',
  source: 'network',
  seenAt: Date.now(),
  duration: 5_400,
  drm: true,
  drmSystem: 'Widevine',
  tracks: { video: true, audio: false },
};

function dashVideo(height: number, bandwidth: number): MediaVariant {
  return {
    id: hashString(`dash-v${height}`),
    url: 'https://cdn.example.test/dash/keynote.mpd',
    kind: 'video',
    protocol: 'dash',
    format: 'mp4',
    bandwidth,
    resolution: { width: Math.round((height * 16) / 9), height },
    codecs: ['avc1.640028'],
    // A DASH video representation: the sound is a separate adaptation set.
    tracks: { video: true, audio: false },
    dashRepresentationId: `v${height}`,
    dashAdaptationSetId: 'video',
  };
}

const separateAudio: MediaCandidate = {
  id: 'fixture-dash-video-only',
  url: 'https://cdn.example.test/dash/keynote.mpd',
  pageUrl: PAGE_URL,
  pageTitle: PAGE_TITLE,
  title: 'Keynote (audio in a separate track)',
  kind: 'video',
  protocol: 'dash',
  format: 'mp4',
  source: 'network',
  seenAt: Date.now(),
  duration: 2_400,
  posterUrl: POSTER,
  tracks: { video: true, audio: true },
  variants: [dashVideo(1080, 4_800_000), dashVideo(720, 2_600_000)],
  audioTracks: [
    {
      id: hashString('dash-a128'),
      url: 'https://cdn.example.test/dash/keynote.mpd',
      kind: 'audio',
      protocol: 'dash',
      format: 'mp4',
      bandwidth: 128_000,
      codecs: ['mp4a.40.2'],
      tracks: { video: false, audio: true },
      dashRepresentationId: 'a128',
      dashAdaptationSetId: 'audio',
    },
  ],
};

export const scanFixture: ScanResult = {
  tabId: 1,
  pageUrl: PAGE_URL,
  pageTitle: PAGE_TITLE,
  scannedAt: Date.now(),
  // The stream's 4K rung is too large to assemble (16 Mbps for half an hour),
  // so its best download is the 1080p rung.
  candidates: rank([
    decided(stream, probed(307)),
    decided(progressive),
    decided(podcast),
    decided(protectedStream),
    decided(encryptedStream, probed(420, true)),
    decided(liveStream, probed(5)),
  ]),
  rejected: [
    {
      url: 'https://cdn.example.test/thumbs/poster.jpg',
      reason: 'score 6 below display threshold',
    },
    { url: 'https://ads.example.test/preroll.mp4', reason: 'score 0 below display threshold' },
  ],
  stats: {
    networkRequestsObserved: 243,
    mediaElements: 2,
    candidatesRaw: 17,
    candidatesAfterDedupe: 6,
    manifestsParsed: 2,
    byProtocol: { progressive: 2, hls: 1, dash: 1, blob: 1, data: 0, unknown: 1 },
    parseErrors: 0,
  },
};

export const emptyScanFixture: ScanResult = {
  ...scanFixture,
  candidates: [],
  diagnosis: {
    code: 'MSE_ONLY',
    reasons: [
      'The player builds the video in JavaScript (Media Source Extensions), so there is no single file to fetch.',
      'The underlying manifest is usually visible once playback starts - press play, then scan again.',
    ],
  },
};

/**
 * The stream only exists as separate video and audio (DASH), so "best" is two
 * files, and the buttons have to say so; each video rendition on its own is
 * silent, and says that.
 */
export const videoOnlyScanFixture: ScanResult = {
  ...scanFixture,
  candidates: rank([decided(separateAudio, { document: 'dash', periods: 1 })]),
};

/** Media was found, but every item is DRM-protected: nothing is downloadable. */
export const protectedOnlyScanFixture: ScanResult = {
  ...scanFixture,
  candidates: rank([decided(protectedStream)]),
};

export const downloadsFixture: DownloadTaskView[] = [
  {
    id: 't1',
    filename: 'MediaGrab/How to Build a Startup [1080p].ts',
    url: 'https://cdn.example.test/hls/1080/index.m3u8',
    pageUrl: PAGE_URL,
    state: DownloadState.DOWNLOADING,
    strategy: 'segment-hls',
    pausable: false,
    kind: 'video',
    progress: {
      receivedBytes: 1_288_490_189,
      // BANDWIDTH x duration from the manifest, so the row shows it as "~".
      totalBytes: 1_567_651_430,
      totalEstimated: true,
      speedBps: 8_808_038,
      etaSeconds: 31,
      segmentsDone: 412,
      segmentsTotal: 501,
    },
    createdAt: Date.now() - 120_000,
    updatedAt: Date.now(),
    attempts: 1,
  },
  {
    id: 't4',
    filename: 'MediaGrab/Backstage interview.mp4',
    url: 'https://cdn.example.test/files/interview.mp4',
    pageUrl: PAGE_URL,
    state: DownloadState.DOWNLOADING,
    strategy: 'browser-download',
    pausable: true,
    kind: 'video',
    progress: {
      receivedBytes: 37_000_000,
      totalBytes: 148_000_000,
      speedBps: 3_145_728,
      etaSeconds: 35,
    },
    createdAt: Date.now() - 20_000,
    updatedAt: Date.now(),
    attempts: 1,
    browserDownloadId: 12,
  },
  {
    id: 't2',
    filename: 'MediaGrab/Episode 14 - Scaling teams [audio].mp3',
    url: 'https://cdn.example.test/audio/episode-14.mp3',
    pageUrl: PAGE_URL,
    state: DownloadState.COMPLETED,
    strategy: 'browser-download',
    pausable: true,
    kind: 'audio',
    progress: { receivedBytes: 66_000_000, totalBytes: 66_000_000, speedBps: 0 },
    createdAt: Date.now() - 600_000,
    updatedAt: Date.now() - 540_000,
    completedAt: Date.now() - 540_000,
    attempts: 1,
    browserDownloadId: 9,
  },
  {
    id: 't3',
    filename: 'MediaGrab/Feature film [1080p].mp4',
    url: 'https://cdn.example.test/dash/protected.mpd',
    pageUrl: PAGE_URL,
    state: DownloadState.FAILED,
    strategy: 'segment-dash',
    pausable: false,
    kind: 'video',
    progress: { receivedBytes: 0, speedBps: 0 },
    createdAt: Date.now() - 300_000,
    updatedAt: Date.now() - 290_000,
    attempts: 3,
    error: { code: 'STREAM_EXPIRED', message: 'The link expired.' },
  },
  {
    // A CDN that wants the page as Referer, and MediaGrab has no grant for it (D18).
    id: 't5',
    filename: 'MediaGrab/Trailer [720p].mp4',
    url: 'https://partner-cdn.test/hls/trailer.m3u8',
    pageUrl: PAGE_URL,
    state: DownloadState.FAILED,
    strategy: 'segment-hls',
    pausable: false,
    kind: 'video',
    progress: { receivedBytes: 0, speedBps: 0 },
    createdAt: Date.now() - 200_000,
    updatedAt: Date.now() - 190_000,
    attempts: 1,
    error: { code: 'STREAM_EXPIRED', message: 'HTTP 403', accessHost: 'partner-cdn.test' },
  },
];
