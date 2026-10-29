/**
 * Download history (PRD s34): the list under "History" on the options page.
 *
 *   a download completes -> background/download-hooks.ts -> addHistoryEntry
 *   the options page     -> loadHistory -> groupByDay -> one list per day
 *
 * An entry holds what that list shows and nothing more: the file name, the
 * site's domain and when it finished. No URL is kept - not the media URL, which
 * is often signed (a token in storage is a credential sitting on disk), and not
 * the page URL, which records what the user was reading (SECURITY.md s7).
 */
import { browserApi } from '../browser/index.ts';
import type { DownloadTaskView } from '../core/download-types.ts';
import { domainOf } from '../core/redact.ts';

export interface HistoryEntry {
  /** The download task's id; recording a task twice replaces its earlier entry. */
  id: string;
  /** As saved, including the folder inside the downloads directory. */
  filename: string;
  domain: string;
  completedAt: number;
}

export interface HistoryDay {
  label: string;
  entries: HistoryEntry[];
}

const KEY = 'history';

/**
 * A stored value without an entry's shape is skipped instead of breaking the
 * whole list. Fields that older versions stored (URLs among them) are dropped
 * here, so the next write removes them from storage too.
 */
export async function loadHistory(): Promise<HistoryEntry[]> {
  const stored = await browserApi().storage.local.get<unknown>(KEY);
  if (!Array.isArray(stored)) return [];
  return stored.map(readEntry).filter((entry): entry is HistoryEntry => entry !== undefined);
}

export function addHistoryEntry(task: DownloadTaskView, limit: number): Promise<void> {
  if (limit <= 0) return Promise.resolve();
  const entry: HistoryEntry = {
    id: task.id,
    filename: task.filename,
    domain: domainOf(task.pageUrl),
    completedAt: task.completedAt ?? Date.now(),
  };
  return oneAtATime(async () => {
    const history = await loadHistory();
    const next = [entry, ...history.filter((existing) => existing.id !== entry.id)];
    await browserApi().storage.local.set(KEY, next.slice(0, limit));
  });
}

export function clearHistory(): Promise<void> {
  return oneAtATime(() => browserApi().storage.local.remove(KEY));
}

/**
 * Groups by the local calendar day a download finished: "Today", "Yesterday",
 * then the date as YYYY-MM-DD. Days are compared as calendar dates rather than
 * by subtracting 24 hours, because the day the clocks change is 23 or 25 hours
 * long. Entries keep their stored order, newest first.
 */
export function groupByDay(entries: HistoryEntry[], now = new Date()): HistoryDay[] {
  const today = localDate(now);
  const yesterday = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups = new Map<string, HistoryEntry[]>();

  for (const entry of entries) {
    const day = localDate(new Date(entry.completedAt));
    const label = day === today ? 'Today' : day === yesterday ? 'Yesterday' : day;
    const bucket = groups.get(label);
    if (bucket) bucket.push(entry);
    else groups.set(label, [entry]);
  }

  return [...groups].map(([label, dayEntries]) => ({ label, entries: dayEntries }));
}

/** YYYY-MM-DD in the user's time zone; `toISOString` would give the UTC date. */
function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function readEntry(value: unknown): HistoryEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, filename, domain, completedAt } = value as Record<string, unknown>;
  if (typeof id !== 'string' || typeof filename !== 'string' || typeof domain !== 'string') {
    return undefined;
  }
  if (typeof completedAt !== 'number' || !Number.isFinite(completedAt)) return undefined;
  return { id, filename, domain, completedAt };
}

/**
 * Every write is read-modify-write of one list, so writes run one after
 * another: two downloads finishing together would otherwise both read the same
 * list, and the second write would drop the first entry. This orders writes
 * within the worker, which is the only place entries are added.
 */
let lastWrite: Promise<void> = Promise.resolve();

function oneAtATime(write: () => Promise<void>): Promise<void> {
  const next = lastWrite.then(write);
  lastWrite = next.catch(() => undefined);
  return next;
}
