/**
 * Toolbar badge (PRD s2): how many media resources the current tab has.
 *
 *   no media        no badge
 *   media found     the count, per tab (capped at 99)
 *
 * Called by background/scanner.ts after every scan of a tab.
 *
 * Decision: the badge shows the detection count and nothing else. It used to
 * show a global download percentage and an "OK" when a download finished, and
 * both were wrong in practice. Chrome shows a tab's own badge text in preference
 * to the global one, so on the tab where a download started - the tab the user
 * is looking at - the detection count always hid the percentage. And nothing
 * ever cleared the "OK". Download progress lives in the popup's Downloads view
 * and in the browser's own download UI instead.
 */
import { browserApi } from '../browser/index.ts';

const COLORS = {
  idle: '#3f4a52',
  found: '#c8641e',
};

const MAX_SHOWN = 99;

export async function setDetectionBadge(tabId: number, count: number): Promise<void> {
  const api = browserApi();
  if (count <= 0) {
    await api.action.setBadge({ text: '', color: COLORS.idle, tabId });
    await api.action.setTitle('MediaGrab - no media detected', tabId);
    return;
  }
  await api.action.setBadge({
    text: String(Math.min(count, MAX_SHOWN)),
    color: COLORS.found,
    tabId,
  });
  await api.action.setTitle(
    `MediaGrab - ${count} media resource${count === 1 ? '' : 's'} detected`,
    tabId,
  );
}
