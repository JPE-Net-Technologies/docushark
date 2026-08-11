/**
 * StatusBar - Bottom status bar with zoom controls and info.
 *
 * Shows:
 * - Zoom level with quick controls
 * - Shape count
 * - Current active tool
 *
 * Responsive behaviour (JP-486). Almost everything here is *canvas* status, and
 * the bar used to render all of it unconditionally at a fixed 24px — which on a
 * 375px viewport overflowed its own width by ~57px, pushing the active tool name
 * off-screen entirely, with controls far below any touch-target minimum.
 *
 * Two independent signals fix that, deliberately governing different things so
 * they cannot drift:
 *
 * - **Content** is decided here, from `useBreakpoint` — a narrow viewport or a
 *   touch device drops the readouts that are dead (cursor coordinates never
 *   populate without a hover) or unaffordable (shape count, tool name).
 * - **Sizing** is decided in StatusBar.css under `@media (pointer: coarse)`,
 *   the same convention RelaxedFocusControl/resizeHandle/ColorPicker already use.
 *
 * On top of that the bar is *focus-aware*: Relaxed's `write` focus renders no
 * canvas at all, so a zoom cluster there would steer a viewport that isn't on
 * screen. With nothing left worth showing, the bar removes itself rather than
 * hold 24px for an empty strip — the same self-hiding contract as
 * FloatingCollabIndicator. It reappears the moment something ambient and
 * consequential happens (offline, group drill-down, blob sync).
 */

import { useCallback, useMemo } from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { useConnectionStore } from '../store/connectionStore';
import { useSharedDocOffline } from '../collaboration/sharedDocOffline';
import { calculateCombinedBounds } from '../shapes/utils/bounds';
import { useBreakpoint } from './layout/useBreakpoint';
import { useActiveLayoutMode } from './layout/useLayout';
import { isCanvasHidden } from './layout/modes';
import { Icon } from './icons';
import './StatusBar.css';

/**
 * Format blob sync phase for display.
 */
function formatSyncPhase(phase: 'checking' | 'uploading' | 'downloading'): string {
  switch (phase) {
    case 'checking':
      return 'Checking';
    case 'uploading':
      return 'Uploading';
    case 'downloading':
      return 'Downloading';
  }
}

/**
 * Zoom preset values.
 */
const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/**
 * StatusBar component.
 */
export function StatusBar() {
  // Narrow viewport or coarse pointer → the reduced bar. `isTouch` is included
  // so a tablet in landscape (a `medium` band) still gets finger-sized targets.
  const { band, isTouch } = useBreakpoint();
  const compact = band === 'narrow' || isTouch;

  // Is there a canvas on screen to report on? Shared with App via the same pure
  // helper so the two cannot disagree about what "no canvas" means.
  const activeMode = useActiveLayoutMode();
  const relaxedFocus = useSessionStore((state) => state.relaxedFocus);
  const canvasHidden = isCanvasHidden(activeMode, relaxedFocus, band);

  const showCoords = !compact;
  const showCounts = !compact;
  const showZoom = !compact || !canvasHidden;

  const camera = useSessionStore((state) => state.camera);
  const setCamera = useSessionStore((state) => state.setCamera);
  const activeTool = useSessionStore((state) => state.activeTool);
  // The coordinate readout is the *only* consumer of `cursorWorldPosition`,
  // which Engine.handlePointerEvent writes on every normalized pointer event.
  // Selecting a constant when it isn't rendered means the subscription can no
  // longer re-render this bar on every pointer move.
  const cursorWorldPosition = useSessionStore((state) =>
    showCoords ? state.cursorWorldPosition : null
  );
  const blobSyncProgress = useSessionStore((state) => state.blobSyncProgress);
  const editingGroupId = useSessionStore((state) => state.editingGroupId);
  const setEditingGroupId = useSessionStore((state) => state.setEditingGroupId);
  const shapeCount = useDocumentStore((state) => state.shapeOrder.length);

  // Ambient connection indicator (JP-237): a relay-backed doc that isn't fully
  // synced is "offline". Driven by connection state (not a transient event), so
  // it stays visible the whole time you're offline — including a doc opened
  // offline-from-start where no provider ever attaches and no toast can fire.
  const sharedOffline = useSharedDocOffline();
  const connStatus = useConnectionStore((s) => s.status);
  const reconnectPhase = useConnectionStore((s) => s.reconnectPhase);
  const reconnecting =
    connStatus === 'connecting' ||
    connStatus === 'authenticating' ||
    reconnectPhase === 'reconnecting';

  // Memoize sync status text
  const syncStatusText = useMemo(() => {
    if (!blobSyncProgress) return null;
    return `${formatSyncPhase(blobSyncProgress.phase)} files: ${blobSyncProgress.current}/${blobSyncProgress.total}`;
  }, [blobSyncProgress]);

  // Zoom controls
  const handleZoomIn = useCallback(() => {
    const currentZoom = camera.zoom;
    const nextZoom = ZOOM_PRESETS.find((z) => z > currentZoom) || currentZoom * 1.25;
    setCamera({ zoom: Math.min(10, nextZoom) });
  }, [camera.zoom, setCamera]);

  const handleZoomOut = useCallback(() => {
    const currentZoom = camera.zoom;
    const nextZoom = [...ZOOM_PRESETS].reverse().find((z) => z < currentZoom) || currentZoom / 1.25;
    setCamera({ zoom: Math.max(0.1, nextZoom) });
  }, [camera.zoom, setCamera]);

  const handleZoomFit = useCallback(() => {
    // Get all shapes and calculate combined bounds
    const documentState = useDocumentStore.getState();
    const shapes = Object.values(documentState.shapes);

    if (shapes.length === 0) {
      // No shapes, reset to default view
      setCamera({ x: 0, y: 0, zoom: 1 });
      return;
    }

    const bounds = calculateCombinedBounds(shapes);
    if (!bounds) {
      setCamera({ x: 0, y: 0, zoom: 1 });
      return;
    }

    // Measure the real canvas area. The previous constants (70% of the window
    // width, height minus 100) hard-coded a desktop shell with side panels
    // taking the other 30%; wherever the panels are hidden — every mobile
    // layout, and Designer with the document panel closed — that under-zoomed
    // by a wide margin. Fall back to the old approximation if the wrapper isn't
    // mounted (e.g. Relaxed `write` focus, where Fit isn't reachable anyway).
    //
    // NOTE: `Camera.zoomToFit(bounds, padding)` already does this correctly from
    // the camera's own `setViewport` dimensions, but the Camera instance lives
    // in CanvasContainer's local state and isn't reachable from here without new
    // plumbing. Worth collapsing onto that once the engine is addressable.
    const canvasRect = document
      .querySelector('.canvas-area-wrapper')
      ?.getBoundingClientRect();
    const viewportWidth =
      canvasRect && canvasRect.width > 0 ? canvasRect.width : window.innerWidth * 0.7;
    const viewportHeight =
      canvasRect && canvasRect.height > 0 ? canvasRect.height : window.innerHeight - 100;

    // Add padding (10% on each side)
    const padding = 0.1;
    const contentWidth = bounds.width * (1 + padding * 2);
    const contentHeight = bounds.height * (1 + padding * 2);

    // Calculate zoom to fit content
    const zoomX = viewportWidth / contentWidth;
    const zoomY = viewportHeight / contentHeight;
    const zoom = Math.min(zoomX, zoomY, 2); // Cap at 2x zoom

    // Center camera on content bounds center
    const centerX = bounds.center.x;
    const centerY = bounds.center.y;

    setCamera({ x: centerX, y: centerY, zoom: Math.max(0.1, zoom) });
  }, [setCamera]);

  const handleZoom100 = useCallback(() => {
    setCamera({ zoom: 1 });
  }, [setCamera]);

  // Format zoom percentage
  const zoomPercent = Math.round(camera.zoom * 100);

  // Format tool name
  const toolDisplayName = activeTool.charAt(0).toUpperCase() + activeTool.slice(1);

  // Everything the reduced bar could still carry is ambient and conditional. If
  // none of it applies there is nothing to say, so don't hold a strip to say it.
  const hasAmbient = sharedOffline || editingGroupId !== null || syncStatusText !== null;
  if (compact && !showZoom && !hasAmbient) return null;

  return (
    <div className={`status-bar${compact ? ' status-bar--compact' : ''}`}>
      {/* Left Section: Cursor Position. Dropped when compact — a coarse pointer
          has no hover, so this reads "—" except mid-drag, for a fixed 120px. */}
      {showCoords && (
        <div className="status-bar-section status-bar-left">
          <span className="status-bar-label">X:</span>
          <span className="status-bar-value">{cursorWorldPosition ? Math.round(cursorWorldPosition.x) : '—'}</span>
          <span className="status-bar-label">Y:</span>
          <span className="status-bar-value">{cursorWorldPosition ? Math.round(cursorWorldPosition.y) : '—'}</span>
        </div>
      )}

      {/* Center Section: Zoom Controls. Steers the canvas, so it goes wherever
          the canvas does. */}
      {showZoom && (
        <div className="status-bar-section status-bar-center">
          <button className="status-bar-zoom-btn" onClick={handleZoomOut} title="Zoom out" aria-label="Zoom out">
            -
          </button>
          <span className="status-bar-zoom-value">{zoomPercent}%</span>
          <button className="status-bar-zoom-btn" onClick={handleZoomIn} title="Zoom in" aria-label="Zoom in">
            +
          </button>
          <div className="status-bar-divider" />
          <button className="status-bar-btn" onClick={handleZoomFit} title="Fit to center">
            Fit
          </button>
          <button className="status-bar-btn" onClick={handleZoom100} title="Reset to 100%">
            100%
          </button>
        </div>
      )}

      {/* Right Section: Info */}
      <div className="status-bar-section status-bar-right">
        {/* Ambient connection status — offline / reconnecting */}
        {sharedOffline && (
          <>
            <span
              className={`status-bar-conn status-bar-conn--${reconnecting ? 'reconnecting' : 'offline'}`}
              title={
                reconnecting
                  ? 'Reconnecting to the workspace…'
                  : "You're offline. Changes are saved on this device and will sync when you reconnect."
              }
            >
              <Icon icon={reconnecting ? RefreshCw : WifiOff} size={13} />
              <span>{reconnecting ? 'Reconnecting…' : 'Offline'}</span>
            </span>
            <div className="status-bar-divider" />
          </>
        )}
        {/* Drill-down badge */}
        {editingGroupId && (
          <>
            <button
              type="button"
              className="status-bar-drill-badge"
              onClick={() => setEditingGroupId(null)}
              title="You've drilled into a group. Clicks inside it select shapes directly and pass through any nested groups. Click outside the group, press Escape, or click this badge to exit."
              aria-label="Exit group drill-down"
            >
              <span aria-hidden="true">⤵</span>
              <span>In group</span>
              <span className="status-bar-drill-badge-x" aria-hidden="true">×</span>
            </button>
            <div className="status-bar-divider" />
          </>
        )}
        {/* Blob Sync Progress */}
        {syncStatusText && (
          <>
            <span className="status-bar-sync" title="File sync in progress">
              {syncStatusText}
            </span>
            <div className="status-bar-divider" />
          </>
        )}
        {/* Shape count + active tool: reference readouts, not controls. They
            are the first thing to go when width is scarce — and they were the
            content the old fixed layout pushed off-screen. */}
        {showCounts && (
          <>
            <span className="status-bar-info">
              <span className="status-bar-label">Shapes:</span>
              <span className="status-bar-value">{shapeCount.toLocaleString()}</span>
            </span>
            <div className="status-bar-divider" />
            <span className="status-bar-tool">{toolDisplayName}</span>
          </>
        )}
      </div>
    </div>
  );
}

export default StatusBar;
