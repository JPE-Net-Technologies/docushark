/**
 * StatusBar - the document's status line (DSK-211).
 *
 * It describes the document, never one surface's tools: while you write, the
 * open page's word count (the selection's while text is selected) and its place
 * among the pages, with Document stats one click away; while you draw, the shape
 * count, the selection and the cursor's position. The canvas's own controls
 * (zoom, fit, the minimap) live on the canvas in `CanvasZoomPill`, so they exist
 * only where a canvas is.
 *
 * Which surface it describes comes from `useActiveSurface`: the only one on
 * screen, or the one last worked in when both are.
 *
 * Responsive behaviour (JP-486). On a 375px viewport the old fixed bar
 * overflowed its own width by ~57px, with controls far below any touch-target
 * minimum. Two independent signals keep it in check:
 *
 * - **Content** is decided here, from `useBreakpoint`: a narrow viewport or a
 *   touch device drops the readouts, keeping only ambient state.
 * - **Sizing** is decided in StatusBar.css under `@media (pointer: coarse)`.
 *
 * With nothing left worth showing, the bar removes itself rather than hold an
 * empty strip, the same self-hiding contract as FloatingCollabIndicator. It
 * reappears the moment something ambient and consequential happens (offline,
 * group drill-down, blob sync).
 */

import { useMemo } from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { useConnectionStore } from '../store/connectionStore';
import { useSharedDocOffline } from '../collaboration/sharedDocOffline';
import { useBreakpoint } from './layout/useBreakpoint';
import { useActiveSurface } from './layout/useActiveSurface';
import { ProseReadout } from './DocumentStats';
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

export function StatusBar() {
  // Narrow viewport or coarse pointer → the reduced bar. `isTouch` is included
  // so a tablet in landscape (a `medium` band) still gets finger-sized targets.
  const { band, isTouch } = useBreakpoint();
  const compact = band === 'narrow' || isTouch;
  const surface = useActiveSurface();
  const describesCanvas = !compact && surface === 'canvas';

  // The coordinate readout is the only consumer of `cursorWorldPosition`, which
  // the engine writes on every pointer event. Selecting a constant when it isn't
  // shown keeps it from re-rendering this bar on every pointer move.
  const cursorWorldPosition = useSessionStore((state) =>
    describesCanvas ? state.cursorWorldPosition : null
  );
  const selectedCount = useSessionStore((state) => (describesCanvas ? state.selectedIds.size : 0));
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

  const syncStatusText = useMemo(() => {
    if (!blobSyncProgress) return null;
    return `${formatSyncPhase(blobSyncProgress.phase)} files: ${blobSyncProgress.current}/${blobSyncProgress.total}`;
  }, [blobSyncProgress]);

  // Everything the reduced bar carries is ambient and conditional. If none of it
  // applies there is nothing to say, so don't hold a strip to say it.
  const hasAmbient = sharedOffline || editingGroupId !== null || syncStatusText !== null;
  if (compact && !hasAmbient) return null;

  return (
    <div className={`status-bar${compact ? ' status-bar--compact' : ''}`}>
      {/* Left: what you're working on. Dropped when compact — the space goes to
          ambient state. */}
      {!compact && (
        <div className="status-bar-section status-bar-left">
          {surface === 'prose' ? (
            <ProseReadout />
          ) : (
            <>
              <span className="status-bar-label">X:</span>
              <span className="status-bar-value">{cursorWorldPosition ? Math.round(cursorWorldPosition.x) : '—'}</span>
              <span className="status-bar-label">Y:</span>
              <span className="status-bar-value">{cursorWorldPosition ? Math.round(cursorWorldPosition.y) : '—'}</span>
            </>
          )}
        </div>
      )}

      {/* Right Section: ambient state, then the canvas's counts */}
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
            {(editingGroupId || syncStatusText || describesCanvas) && <div className="status-bar-divider" />}
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
            {(syncStatusText || describesCanvas) && <div className="status-bar-divider" />}
          </>
        )}
        {/* Blob Sync Progress */}
        {syncStatusText && (
          <>
            <span className="status-bar-sync" title="File sync in progress">
              {syncStatusText}
            </span>
            {describesCanvas && <div className="status-bar-divider" />}
          </>
        )}
        {/* The canvas's counts: reference readouts, the first thing to go when
            width is scarce. */}
        {describesCanvas && (
          <span className="status-bar-info">
            {shapeCount.toLocaleString()} {shapeCount === 1 ? 'shape' : 'shapes'}
            {selectedCount > 0 && <span className="status-bar-selection"> · {selectedCount.toLocaleString()} selected</span>}
          </span>
        )}
      </div>
    </div>
  );
}

export default StatusBar;
