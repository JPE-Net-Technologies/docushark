/**
 * DocumentToggleRail — small floating button on the canvas edge that brings
 * the Document panel back when it's hidden. Anchors to whichever dock side
 * the panel will reappear on (preserved across hide/show round-trips because
 * dock and visibility are independent fields in the layout model).
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
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
      {side === 'left' ? (
        <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" />
      ) : (
        <ChevronLeft size={14} strokeWidth={1.5} aria-hidden="true" />
      )}
    </button>
  );
}
