import { useUploadStatusStore } from '../store/uploadStatusStore';

/**
 * Minimal upload-progress indicator (JP-126). Visible while a save uploads
 * referenced assets to the relay blob store; file-count granularity. Styling is
 * intentionally bare — the comprehensive design is owned separately.
 */
export function UploadIndicator() {
  const active = useUploadStatusStore((s) => s.active);
  const phase = useUploadStatusStore((s) => s.phase);
  const current = useUploadStatusStore((s) => s.current);
  const total = useUploadStatusStore((s) => s.total);

  if (!active || phase !== 'uploading' || total === 0) return null;
  const pct = Math.min(100, Math.round((current / total) * 100));

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
      <div>
        Uploading assets… {current} of {total}
      </div>
      <div style={{ height: 4, marginTop: 6, borderRadius: 2, background: '#444' }}>
        <div
          style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: '#4ea1ff' }}
        />
      </div>
    </div>
  );
}
