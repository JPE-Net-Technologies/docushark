import { useEffect, useState } from 'react';
import { useUploadStatusStore } from '../store/uploadStatusStore';
import { inFlightDownloadCount, onBlobLoad } from '../storage/blobResolver';

/**
 * Sync-activity indicator. Visible while assets **upload** to the relay blob
 * store on save (JP-126) or **download** into local cache on demand (JP-129).
 * File-count granularity — per-byte progress within a file is a follow-up (needs
 * an XHR upload transport; `fetch` has no upload-progress events).
 *
 * Uploads come from `uploadStatusStore`; downloads resolve lazily through the
 * blob resolver (not in that store), which signals start/finish via `onBlobLoad`
 * — so the indicator subscribes to that for the live download count. (Previously
 * this only rendered the `uploading` phase, so an active download never showed.)
 */
export function UploadIndicator() {
  const uploadActive = useUploadStatusStore((s) => s.active);
  const phase = useUploadStatusStore((s) => s.phase);
  const current = useUploadStatusStore((s) => s.current);
  const total = useUploadStatusStore((s) => s.total);

  const [downloads, setDownloads] = useState(0);
  useEffect(() => onBlobLoad(() => setDownloads(inFlightDownloadCount())), []);

  const uploading = uploadActive && phase === 'uploading' && total > 0;
  if (!uploading && downloads === 0) return null;

  const label = uploading
    ? `Uploading assets… ${current} of ${total}`
    : `Downloading files… ${downloads}`;
  const pct = uploading ? Math.min(100, Math.round((current / total) * 100)) : null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        zIndex: 9999,
        minWidth: 180,
        padding: '8px 12px',
        borderRadius: 6,
        background: 'rgba(20,20,20,0.92)',
        color: '#fff',
        fontSize: 12,
        fontFamily: 'sans-serif',
      }}
    >
      <div>{label}</div>
      {pct !== null && (
        <div style={{ height: 4, marginTop: 6, borderRadius: 2, background: '#444' }}>
          <div
            style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: '#4ea1ff' }}
          />
        </div>
      )}
    </div>
  );
}
