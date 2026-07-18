/**
 * BlobSyncToastBridge — headless bridge that surfaces blob sync activity
 * (asset uploads on save, lazy downloads on demand) through the notification
 * system as ONE update-in-place progress toast per burst. Replaces the old
 * standalone bottom-right UploadIndicator pill so sync activity and sync
 * errors share a single surface.
 *
 * Burst behavior: the toast only appears after activity has been sustained
 * for a short threshold (cache hits and single tiny files shouldn't flash a
 * toast), updates in place while work continues, flips to a success message
 * on completion, and auto-dismisses shortly after.
 *
 * Granularity is file-count (matching the data available — fetch exposes no
 * upload-progress events on this platform).
 */

import { useEffect, useRef, useState } from 'react';
import { useUploadStatusStore } from '../store/uploadStatusStore';
import { inFlightDownloadCount, onBlobLoad } from '../storage/blobResolver';
import { useNotificationStore } from '../store/notificationStore';
import {
  blobSyncMessage,
  BLOB_SYNC_DONE_MESSAGE,
  type BlobSyncActivity,
} from '../collaboration/blobSyncMessages';

/** Activity must persist this long before a toast appears. */
const SHOW_DELAY_MS = 400;
/** How long the completion state lingers before dismissing. */
const DONE_DISMISS_MS = 2500;

export function BlobSyncToastBridge() {
  const uploadActive = useUploadStatusStore((s) => s.active);
  const phase = useUploadStatusStore((s) => s.phase);
  const current = useUploadStatusStore((s) => s.current);
  const total = useUploadStatusStore((s) => s.total);

  const [downloads, setDownloads] = useState(0);
  useEffect(() => onBlobLoad(() => setDownloads(inFlightDownloadCount())), []);

  const uploading = uploadActive && phase === 'uploading' && total > 0;
  const activity: BlobSyncActivity | null = uploading
    ? { kind: 'upload', current, total }
    : downloads > 0
      ? { kind: 'download', current: downloads, total: 0 }
      : null;

  const toastIdRef = useRef<string | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityRef = useRef(activity);
  activityRef.current = activity;

  useEffect(() => {
    const notifications = useNotificationStore.getState();

    if (activity) {
      if (toastIdRef.current) {
        notifications.update(toastIdRef.current, {
          message: blobSyncMessage(activity),
          severity: 'info',
          ...(activity.kind === 'upload'
            ? { progress: { current: activity.current, total: activity.total } }
            : {}),
        });
      } else if (showTimerRef.current === null) {
        showTimerRef.current = setTimeout(() => {
          showTimerRef.current = null;
          const live = activityRef.current;
          if (!live) return; // burst ended before the threshold — no toast
          toastIdRef.current = notifications.notify({
            message: blobSyncMessage(live),
            severity: 'info',
            duration: 0,
            ...(live.kind === 'upload'
              ? { progress: { current: live.current, total: live.total } }
              : {}),
          });
        }, SHOW_DELAY_MS);
      }
      return undefined;
    }

    // Burst over: cancel a pending show, or complete + dismiss the live toast.
    if (showTimerRef.current !== null) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (toastIdRef.current) {
      const id = toastIdRef.current;
      toastIdRef.current = null;
      notifications.update(id, { message: BLOB_SYNC_DONE_MESSAGE, severity: 'success' });
      const t = setTimeout(() => useNotificationStore.getState().dismiss(id), DONE_DISMISS_MS);
      return () => clearTimeout(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploading, current, total, downloads]);

  return null;
}

export default BlobSyncToastBridge;
