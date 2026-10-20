/**
 * The user-facing mirror page actions (DSK-193): one home for their feedback
 * and confirmation copy. The mirror banner, the prose tab menu and the
 * Navigator all call these.
 *
 * The tab menu and the Navigator used to carry their own copies, and they had
 * drifted: the Navigator's refresh gave no success feedback, and its detach
 * confirmation dropped the "cannot be undone" line.
 */
import { refreshMirrorPage, detachMirrorPage } from './mirrorPageService';
import { useNotificationStore } from '../store/notificationStore';
import { confirmDialog } from '../ui/confirm/confirmStore';
import { opener } from '../platform/opener';

/**
 * Refresh a mirror page from its source and report the outcome, including how
 * many source elements could not be mirrored. Resolves true on success.
 */
export async function refreshMirrorPageWithFeedback(pageId: string): Promise<boolean> {
  const notifications = useNotificationStore.getState();
  try {
    const { warnings } = await refreshMirrorPage(pageId);
    const dropped = warnings.reduce((n, w) => n + (w.count ?? 1), 0);
    notifications.success(
      dropped > 0 ? `Page refreshed — ${dropped} element(s) could not be mirrored` : 'Page refreshed from source',
    );
    return true;
  } catch (e) {
    notifications.error(e instanceof Error ? e.message : 'Refresh failed.');
    return false;
  }
}

/**
 * Ask, then detach a mirror page into a normal, editable page that keeps the
 * content as last synced. Resolves true when the page was detached.
 */
export async function detachMirrorPageWithConfirm(pageId: string, providerLabel: string): Promise<boolean> {
  const confirmed = await confirmDialog({
    title: `Detach from ${providerLabel}?`,
    message: 'The page becomes a normal, editable page with the content as last synced.',
    details: 'This cannot be undone — re-adding the source later creates a new page.',
    confirmLabel: 'Detach',
  });
  if (confirmed) detachMirrorPage(pageId);
  return confirmed;
}

/** Open a mirror page's source in the user's browser. */
export function openMirrorSource(url: string): void {
  void opener.openExternalUrl(url);
}
