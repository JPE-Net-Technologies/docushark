/**
 * StatusBar - Bottom status bar with zoom controls and info.
 *
 * Shows:
 * - Zoom level with quick controls
 * - Shape count
 * - Current active tool
 */

import { useCallback, useMemo } from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { useConnectionStore } from '../store/connectionStore';
import { useSharedDocOffline } from '../collaboration/sharedDocOffline';
import { calculateCombinedBounds } from '../shapes/utils/bounds';
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
  const camera = useSessionStore((state) => state.camera);
  const setCamera = useSessionStore((state) => state.setCamera);
  const activeTool = useSessionStore((state) => state.activeTool);
  const cursorWorldPosition = useSessionStore((state) => state.cursorWorldPosition);
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

    // Get viewport size (approximate from document body or use defaults)
    // StatusBar doesn't have direct access to viewport, so we use window
    const viewportWidth = window.innerWidth * 0.7; // Approximate canvas width
    const viewportHeight = window.innerHeight - 100; // Approximate canvas height

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

  return (
    <div className="status-bar">
      {/* Left Section: Cursor Position */}
      <div className="status-bar-section status-bar-left">
        <span className="status-bar-label">X:</span>
        <span className="status-bar-value">{cursorWorldPosition ? Math.round(cursorWorldPosition.x) : '—'}</span>
        <span className="status-bar-label">Y:</span>
        <span className="status-bar-value">{cursorWorldPosition ? Math.round(cursorWorldPosition.y) : '—'}</span>
      </div>

      {/* Center Section: Zoom Controls */}
      <div className="status-bar-section status-bar-center">
        <button className="status-bar-zoom-btn" onClick={handleZoomOut} title="Zoom out">
          -
        </button>
        <span className="status-bar-zoom-value">{zoomPercent}%</span>
        <button className="status-bar-zoom-btn" onClick={handleZoomIn} title="Zoom in">
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
        <span className="status-bar-info">
          <span className="status-bar-label">Shapes:</span>
          <span className="status-bar-value">{shapeCount.toLocaleString()}</span>
        </span>
        <div className="status-bar-divider" />
        <span className="status-bar-tool">{toolDisplayName}</span>
      </div>
    </div>
  );
}

export default StatusBar;
