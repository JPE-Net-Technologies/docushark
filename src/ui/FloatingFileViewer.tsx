/**
 * FloatingFileViewer — draggable, resizable side-panel host for
 * FileViewerContent (desktop only), so a PDF can be read next to the document.
 *
 * Non-modal on purpose: no backdrop, no focus trap, the canvas stays live.
 * Escape closes only when focus is inside the panel. Dragging uses pointer
 * events with window-level move/up listeners (HTML5 DnD is dead in WebKitGTK;
 * same pattern as FloatingCollabIndicator), applies a transform during the
 * drag, and commits bounds to uiPreferencesStore only on release.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PictureInPicture2 } from 'lucide-react';
import { Icon } from './icons';
import { useSessionStore } from '../store/sessionStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import {
  clampPanelBounds,
  resolveViewerPanelBounds,
  type PanelBounds,
} from './floatingPosition';
import { FileViewerContent } from './FileViewerContent';
import type { FileDescriptor } from './fileDescriptor';
import './FloatingFileViewer.css';

export interface FloatingFileViewerProps {
  descriptor: FileDescriptor;
  onClose: () => void;
}

type ResizeEdge = 'right' | 'bottom' | 'corner';

interface DragState {
  pointerStart: { x: number; y: number };
  boundsStart: PanelBounds;
  mode: 'move' | ResizeEdge;
}

function viewportSize() {
  return { w: window.innerWidth, h: window.innerHeight };
}

export function FloatingFileViewer({ descriptor, onClose }: FloatingFileViewerProps) {

  const setFileViewerMode = useSessionStore((s) => s.setFileViewerMode);
  const storedBounds = useUIPreferencesStore((s) => s.floatingViewerBounds);
  const setStoredBounds = useUIPreferencesStore((s) => s.setFloatingViewerBounds);

  // Effective bounds: stored (clamped) or the right-side default. Local state
  // during drag/resize; committed to the store on release only.
  const [bounds, setBounds] = useState<PanelBounds>(() =>
    resolveViewerPanelBounds(storedBounds ?? null, viewportSize()),
  );
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const dragRef = useRef<DragState | null>(null);

  // Re-clamp (render-only) when the window resizes so the panel can't strand.
  useEffect(() => {
    const onResize = () => {
      setBounds((b) => clampPanelBounds(b, viewportSize()));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const beginGesture = useCallback((e: React.PointerEvent, mode: DragState['mode']) => {
    // Header buttons/inputs must keep working — only bare header surface drags.
    if (mode === 'move' && (e.target as HTMLElement).closest('button, input, a')) {
      return;
    }
    e.preventDefault();
    dragRef.current = {
      pointerStart: { x: e.clientX, y: e.clientY },
      boundsStart: boundsRef.current,
      mode,
    };
  }, []);

  // Window-level move/up so the pointer can leave the handle mid-gesture.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.pointerStart.x;
      const dy = e.clientY - drag.pointerStart.y;
      const { boundsStart, mode } = drag;
      let next: PanelBounds;
      if (mode === 'move') {
        next = { ...boundsStart, x: boundsStart.x + dx, y: boundsStart.y + dy };
      } else {
        next = {
          ...boundsStart,
          w: mode !== 'bottom' ? boundsStart.w + dx : boundsStart.w,
          h: mode !== 'right' ? boundsStart.h + dy : boundsStart.h,
        };
      }
      setBounds(clampPanelBounds(next, viewportSize()));
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setStoredBounds(boundsRef.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [setStoredBounds]);

  // Escape closes only when focus is inside the panel (non-modal behavior).
  // The PDF reader's find bar stops propagation first, keeping its ordering.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  if (!descriptor) {
    return null;
  }

  return createPortal(
    <div
      className="floating-file-viewer"
      style={{
        left: `${bounds.x}px`,
        top: `${bounds.y}px`,
        width: `${bounds.w}px`,
        height: `${bounds.h}px`,
      }}
      role="complementary"
      aria-label={`File viewer: ${descriptor.fileName}`}
      onKeyDown={handleKeyDown}
    >
      <FileViewerContent
        descriptor={descriptor}
        onClose={onClose}
        headerPointerDown={(e) => beginGesture(e, 'move')}
        headerExtras={
          <button
            className="file-viewer-action-btn"
            onClick={() => setFileViewerMode('modal')}
            title="Dock back to full-screen"
          >
            <Icon icon={PictureInPicture2} size={14} />
          </button>
        }
      />
      <div
        className="floating-file-viewer__resize floating-file-viewer__resize--right"
        onPointerDown={(e) => beginGesture(e, 'right')}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel width"
      />
      <div
        className="floating-file-viewer__resize floating-file-viewer__resize--bottom"
        onPointerDown={(e) => beginGesture(e, 'bottom')}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize panel height"
      />
      <div
        className="floating-file-viewer__resize floating-file-viewer__resize--corner"
        onPointerDown={(e) => beginGesture(e, 'corner')}
        role="separator"
        aria-label="Resize panel"
      />
    </div>,
    document.body,
  );
}

export default FloatingFileViewer;
