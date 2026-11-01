/**
 * Zoom for the canvas's own controls (DSK-211): the zoom pill on the canvas, the
 * command palette and the canvas menu share these, so the steps and the fit
 * can't drift between them. (The E and Q keys are handled by the engine's
 * pan/zoom handler.)
 */
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { calculateCombinedBounds } from '../shapes/utils/bounds';

/** The levels − and + step through. */
export const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;

export function zoomIn(): void {
  const { camera, setCamera } = useSessionStore.getState();
  const next = ZOOM_PRESETS.find((z) => z > camera.zoom) ?? camera.zoom * 1.25;
  setCamera({ zoom: Math.min(MAX_ZOOM, next) });
}

export function zoomOut(): void {
  const { camera, setCamera } = useSessionStore.getState();
  const next = [...ZOOM_PRESETS].reverse().find((z) => z < camera.zoom) ?? camera.zoom / 1.25;
  setCamera({ zoom: Math.max(MIN_ZOOM, next) });
}

export function zoomTo100(): void {
  useSessionStore.getState().setCamera({ zoom: 1 });
}

/** The camera that frames every shape, or the origin at 100% when there are none. */
export function fitCamera(): { x: number; y: number; zoom: number } {
  const bounds = calculateCombinedBounds(Object.values(useDocumentStore.getState().shapes));
  if (!bounds) return { x: 0, y: 0, zoom: 1 };

  // Measure the real canvas area. A fixed estimate (70% of the window, height
  // minus 100) assumed a desktop shell with side panels; wherever they're hidden
  // (every mobile layout, Designer with the document closed) it under-zoomed.
  // Fall back to that estimate if the wrapper isn't mounted.
  //
  // `Camera.zoomToFit(bounds, padding)` does this from the camera's own viewport,
  // but the Camera instance lives in CanvasContainer's local state and isn't
  // reachable from here without new plumbing.
  const canvasRect = document.querySelector('.canvas-area-wrapper')?.getBoundingClientRect();
  const viewportWidth = canvasRect && canvasRect.width > 0 ? canvasRect.width : window.innerWidth * 0.7;
  const viewportHeight = canvasRect && canvasRect.height > 0 ? canvasRect.height : window.innerHeight - 100;

  // 10% padding on each side, and never closer than 2x.
  const padding = 0.1;
  const zoom = Math.min(
    viewportWidth / (bounds.width * (1 + padding * 2)),
    viewportHeight / (bounds.height * (1 + padding * 2)),
    2
  );
  return { x: bounds.center.x, y: bounds.center.y, zoom: Math.max(MIN_ZOOM, zoom) };
}

export function zoomToFit(): void {
  useSessionStore.getState().setCamera(fitCamera());
}

/**
 * Frame everything until the returned function puts the camera back exactly
 * where it was: the zoom pill's press-and-hold peek.
 */
export function peekOverview(): () => void {
  const { camera, setCamera } = useSessionStore.getState();
  const saved = { x: camera.x, y: camera.y, zoom: camera.zoom };
  setCamera(fitCamera());
  return () => useSessionStore.getState().setCamera(saved);
}
