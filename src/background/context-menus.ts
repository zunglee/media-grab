/**
 * Right-click integration (PRD s24).
 *
 * Kept small on purpose: a context menu that lists every rendition is unusable.
 * The menu offers the two decisions worth making without opening the popup -
 * scan, and take the best - and sends everything else to the popup.
 */
import { browserApi } from '../browser/index.ts';

export const MENU_IDS = {
  root: 'mediagrab-root',
  downloadBest: 'mediagrab-download-best',
  scan: 'mediagrab-scan',
} as const;

export async function installContextMenus(): Promise<void> {
  const api = browserApi();
  await api.contextMenus.removeAll();

  api.contextMenus.create({
    id: MENU_IDS.root,
    title: 'MediaGrab',
    contexts: ['page', 'video', 'audio'],
  });
  api.contextMenus.create({
    id: MENU_IDS.downloadBest,
    parentId: MENU_IDS.root,
    title: 'Download the best version',
    contexts: ['page', 'video', 'audio'],
  });
  api.contextMenus.create({
    id: MENU_IDS.scan,
    parentId: MENU_IDS.root,
    title: 'Scan this page again',
    contexts: ['page', 'video', 'audio'],
  });
}
