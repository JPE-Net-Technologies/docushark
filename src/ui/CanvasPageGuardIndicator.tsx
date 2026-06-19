import { Eye } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';

/**
 * JP-341: a small, non-intrusive "view-only" pill shown when the canvas is
 * read-only because of the page-guard — i.e. an online relay collab session is
 * bound to a different canvas page than the one being viewed, so editing here is
 * disabled to stop shapes landing on the wrong page (see JP-340 for the real
 * fix). Reads the single `canvasReadOnly` flag; renders nothing otherwise.
 */
export function CanvasPageGuardIndicator() {
  const readOnly = useSessionStore((state) => state.canvasReadOnly);
  if (!readOnly) return null;

  return (
    <div
      role="status"
      title="Live editing is active on another page of this shared document. Editing here is disabled so changes don't land on the wrong page. Editing any page live is coming soon."
      style={{
        position: 'absolute',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        fontSize: 12,
        fontWeight: 500,
        color: 'var(--text-secondary, #4b5563)',
        background: 'var(--bg-primary, #fff)',
        border: '1px solid var(--border-color, #e5e7eb)',
        borderRadius: 999,
        boxShadow: '0 1px 4px rgba(0, 0, 0, 0.12)',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      <Eye size={14} strokeWidth={1.5} aria-hidden="true" />
      View-only — live editing is on another page of this shared doc
    </div>
  );
}

export default CanvasPageGuardIndicator;
