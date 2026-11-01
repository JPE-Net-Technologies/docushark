/**
 * The canvas's own zoom controls (DSK-211). They sit on the canvas rather than
 * in the shared status line, so they exist only where a canvas is.
 *
 * − and + step through the zoom presets. The percentage returns to 100% on a
 * click; held, it peeks at the whole diagram and puts the view back on release.
 * Fit frames everything, and the map button shows or hides the minimap.
 */
import { useEffect, useRef, type PointerEvent } from 'react';
import { Map as MapIcon, Minus, Plus, Scan } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { peekOverview, zoomIn, zoomOut, zoomTo100, zoomToFit } from '../engine/canvasZoom';
import { Icon } from './icons';
import './CanvasZoomPill.css';

/** How long the percentage is held before it peeks instead of resetting to 100%. */
export const PEEK_HOLD_MS = 300;

export function CanvasZoomPill() {
  const zoomPercent = useSessionStore((s) => Math.round(s.camera.zoom * 100));
  const showMinimap = useSettingsStore((s) => s.showMinimap);
  const toggleMinimap = useSettingsStore((s) => s.toggleShowMinimap);

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restore = useRef<(() => void) | null>(null);
  const endListeners = useRef<(() => void) | null>(null);
  // A hold ends in a click event too; this swallows it so a peek never also resets to 100%.
  const peeked = useRef(false);

  const endHold = () => {
    endListeners.current?.();
    endListeners.current = null;
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    restore.current?.();
    restore.current = null;
  };

  // The hold ends wherever the pointer is released, or if the window loses
  // focus mid-hold, so a peek can never be left zoomed out. Window listeners
  // rather than pointer capture, which some pointers refuse.
  const startHold = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    endHold();
    peeked.current = false;
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      peeked.current = true;
      restore.current = peekOverview();
    }, PEEK_HOLD_MS);
    window.addEventListener('pointerup', endHold);
    window.addEventListener('pointercancel', endHold);
    window.addEventListener('blur', endHold);
    endListeners.current = () => {
      window.removeEventListener('pointerup', endHold);
      window.removeEventListener('pointercancel', endHold);
      window.removeEventListener('blur', endHold);
    };
  };

  // Unmounting mid-hold (the canvas hides) still puts the view back.
  useEffect(() => endHold, []);

  const onPercentClick = () => {
    if (peeked.current) {
      peeked.current = false;
      return;
    }
    zoomTo100();
  };

  return (
    <div className="canvas-zoom-pill" role="toolbar" aria-label="Zoom">
      <button type="button" className="canvas-zoom-pill-btn" onClick={zoomOut} title="Zoom out (Q)" aria-label="Zoom out">
        <Icon icon={Minus} size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="canvas-zoom-pill-btn canvas-zoom-pill-percent"
        onPointerDown={startHold}
        onClick={onPercentClick}
        title="Click for 100%. Hold to see everything."
        aria-label={`Zoom ${zoomPercent}%. Reset to 100%`}
      >
        {zoomPercent}%
      </button>
      <button type="button" className="canvas-zoom-pill-btn" onClick={zoomIn} title="Zoom in (E)" aria-label="Zoom in">
        <Icon icon={Plus} size={14} aria-hidden="true" />
      </button>
      <span className="canvas-zoom-pill-divider" aria-hidden="true" />
      <button type="button" className="canvas-zoom-pill-btn" onClick={zoomToFit} title="Zoom to fit" aria-label="Zoom to fit">
        <Icon icon={Scan} size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`canvas-zoom-pill-btn${showMinimap ? ' is-active' : ''}`}
        onClick={toggleMinimap}
        title={showMinimap ? 'Hide minimap' : 'Show minimap'}
        aria-label="Minimap"
        aria-pressed={showMinimap}
      >
        <Icon icon={MapIcon} size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export default CanvasZoomPill;
