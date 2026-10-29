/**
 * Download history: what an entry keeps, concurrent writes, reading what older
 * versions stored, and grouping by the user's calendar day.
 *
 * Runs in a time zone with daylight saving time, so the day-boundary tests
 * mean something whatever the machine running them is set to.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserApi } from '../../src/browser/api.ts';
import { __setBrowserApi } from '../../src/browser/index.ts';
import { DownloadState, type DownloadTaskView } from '../../src/core/download-types.ts';
import {
  addHistoryEntry,
  groupByDay,
  type HistoryEntry,
  loadHistory,
} from '../../src/storage/history.ts';
import { createFakeBrowserApi } from '../../src/ui/harness/fake-browser.ts';

const originalTimeZone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/New_York';
});
afterAll(() => {
  process.env.TZ = originalTimeZone;
});

let api: BrowserApi;
beforeEach(() => {
  api = createFakeBrowserApi();
  __setBrowserApi(api);
});
afterEach(() => __setBrowserApi(null));

function finished(id: string, overrides: Partial<DownloadTaskView> = {}): DownloadTaskView {
  return {
    id,
    filename: `MediaGrab/${id}.mp4`,
    url: `https://cdn.example/${id}.mp4?token=secret-${id}`,
    pageUrl: `https://www.video.example/watch?v=${id}&session=abc`,
    state: DownloadState.COMPLETED,
    strategy: 'browser-download',
    pausable: true,
    kind: 'video',
    progress: { receivedBytes: 10, totalBytes: 10, speedBps: 0 },
    createdAt: 1,
    updatedAt: 2,
    completedAt: 3,
    attempts: 1,
    ...overrides,
  };
}

function entry(id: string, completedAt: Date): HistoryEntry {
  return { id, filename: `${id}.mp4`, domain: 'video.example', completedAt: completedAt.getTime() };
}

describe('what a history entry keeps', () => {
  it('regression C11: the file name, the domain and the time - no media URL and no page URL', async () => {
    await addHistoryEntry(finished('a'), 10);
    const stored = await api.storage.local.get<unknown[]>('history');

    expect(stored).toEqual([
      { id: 'a', filename: 'MediaGrab/a.mp4', domain: 'www.video.example', completedAt: 3 },
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/https?:|token|session/);
  });

  it('keeps the newest first, replaces a task recorded twice, and honours the limit', async () => {
    await addHistoryEntry(finished('a'), 2);
    await addHistoryEntry(finished('b'), 2);
    await addHistoryEntry(finished('a', { completedAt: 9 }), 2);
    await addHistoryEntry(finished('c'), 2);
    expect((await loadHistory()).map((item) => item.id)).toEqual(['c', 'a']);
  });
});

describe('writing history', () => {
  it('regression C12: two downloads finishing together both get an entry', async () => {
    await Promise.all([addHistoryEntry(finished('a'), 10), addHistoryEntry(finished('b'), 10)]);
    expect((await loadHistory()).map((item) => item.id).sort()).toEqual(['a', 'b']);
  });
});

describe('reading history', () => {
  it('regression CD10: skips malformed entries instead of losing the list', async () => {
    await api.storage.local.set('history', [
      { id: 'ok', filename: 'ok.mp4', domain: 'video.example', completedAt: 5 },
      null,
      'nonsense',
      { id: 'no-time', filename: 'x.mp4', domain: 'video.example' },
      { id: 7, filename: 'x.mp4', domain: 'video.example', completedAt: 5 },
    ]);
    expect((await loadHistory()).map((item) => item.id)).toEqual(['ok']);
  });

  it('reads entries written by older versions and drops the URLs they carried', async () => {
    await api.storage.local.set('history', [
      {
        id: 'old',
        filename: 'old.mp4',
        displayUrl: 'https://cdn.example/old.mp4',
        pageUrl: 'https://video.example/watch?session=abc',
        domain: 'video.example',
        kind: 'video',
        completedAt: 5,
        browserDownloadId: 4,
      },
    ]);
    expect(await loadHistory()).toEqual([
      { id: 'old', filename: 'old.mp4', domain: 'video.example', completedAt: 5 },
    ]);

    await addHistoryEntry(finished('new'), 10);
    const stored = await api.storage.local.get<unknown[]>('history');
    expect(JSON.stringify(stored)).not.toContain('session=abc');
  });
});

describe('history grouped by day', () => {
  it('regression C13: labels a late-evening download with the local date, not the UTC one', () => {
    // 23:30 in New York is already the next day in UTC.
    const groups = groupByDay(
      [entry('late', new Date(2026, 8, 1, 23, 30))],
      new Date(2026, 8, 7, 12),
    );
    expect(groups.map((group) => group.label)).toEqual(['2026-09-01']);
  });

  it('regression C13: "Yesterday" holds across the spring and autumn clock changes', () => {
    // US clocks went forward on 8 March 2026 (a 23-hour day) and go back on
    // 1 November 2026 (a 25-hour day).
    const afterSpring = groupByDay([entry('a', new Date(2026, 2, 8, 9))], new Date(2026, 2, 9, 12));
    const afterAutumn = groupByDay(
      [entry('b', new Date(2026, 10, 1, 9))],
      new Date(2026, 10, 2, 12),
    );
    expect(afterSpring[0]?.label).toBe('Yesterday');
    expect(afterAutumn[0]?.label).toBe('Yesterday');
  });

  it('labels today, yesterday and older days, keeping the stored order', () => {
    const now = new Date(2026, 8, 7, 0, 5);
    const groups = groupByDay(
      [
        entry('a', new Date(2026, 8, 7, 0, 1)),
        entry('b', new Date(2026, 8, 6, 23, 59)),
        entry('c', new Date(2026, 8, 6, 0, 0)),
        entry('d', new Date(2026, 8, 5, 23, 59)),
      ],
      now,
    );
    expect(groups.map((group) => [group.label, group.entries.map((item) => item.id)])).toEqual([
      ['Today', ['a']],
      ['Yesterday', ['b', 'c']],
      ['2026-09-05', ['d']],
    ]);
  });
});
