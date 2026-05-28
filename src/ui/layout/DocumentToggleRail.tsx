/**
 * DocumentToggleRail — small floating button on the canvas edge that brings
 * the Document panel back when it's hidden. Anchors to whichever dock side
 * the panel will reappear on (preserved across hide/show round-trips because
 * dock and visibility are independent fields in the layout model).
 */

import { useLayoutActions } from './useLayout';
import './DocumentToggleRail.css';

interface DocumentToggleRailProps {
  /** Side the rail anchors to — match the dock side the document will return to. */
  side: 'left' | 'right';
}

export function DocumentToggleRail({ side }: DocumentToggleRailProps) {
  const { setPanelVisible } = useLayoutActions();

  return (
    <button
      type="button"
      className={`document-toggle-rail document-toggle-rail-${side}`}
      onClick={() => setPanelVisible('document', true)}
      title="Show document editor"
      aria-label="Show document editor"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        {side === 'left' ? (
          <path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z" />
        ) : (
          <path d="M11.354 1.646a.5.5 0 0 0-.708 0l-6 6a.5.5 0 0 0 0 .708l6 6a.5.5 0 0 0 .708-.708L5.707 8l5.647-5.646a.5.5 0 0 0 0-.708z" />
        )}
      </svg>
    </button>
  );
}
