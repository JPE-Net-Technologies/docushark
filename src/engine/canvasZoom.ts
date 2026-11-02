/**
 * Zoom for the canvas's own controls (DSK-211): the zoom pill on the canvas, the
 * command palette and the canvas menu share these, so the steps and the fit
 * can't drift between them. (The E and Q keys are handled by the engine's
 * pan/zoom handler.)
 */
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { calculateCombinedBounds } from '../shapes/utils/bounds';
import { getAdaptiveBudget } from '../platform/adaptiveBudget';
import { MAX_ZOOM, MIN_ZOOM } from './Camera';

/** The levels − and + step through. */
export const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

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

/** How long the minimap's glide takes. */
export const GLIDE_MS = 220;
let glideFrame: number | null = null;

/**
 * Ease the view's centre to a point over a moment (DSK-212): the minimap's
 * click-to-go. The engine follows the store's camera, so a short tween of it is
 * all a glide needs. A new glide replaces one in progress, and anything else
 * that moves the view's centre mid-glide (a pan, a drag on the map) wins: the
 * glide stops once the centre isn't where it left it. Reduced motion goes
 * straight there.
 */
export function glideCamera(target: { x: number; y: number }): void {
  if (glideFrame !== null) cancelAnimationFrame(glideFrame);
  glideFrame = null;
  const { camera, setCamera } = useSessionStore.getState();
  if (getAdaptiveBudget().reduceMotion) {
    setCamera({ x: target.x, y: target.y });
    return;
  }
  const from = { x: camera.x, y: camera.y };
  let left = from;
  // Timed by the frames' own clock, from the first frame.
  let start: number | null = null;
  const step = (now: number) => {
    const current = useSessionStore.getState().camera;
    if (current.x !== left.x || current.y !== left.y) {
      glideFrame = null;
      return;
    }
    start ??= now;
    const t = Math.min(1, (now - start) / GLIDE_MS);
    const eased = 1 - Math.pow(1 - t, 3); // ease out
    left = { x: from.x + (target.x - from.x) * eased, y: from.y + (target.y - from.y) * eased };
    useSessionStore.getState().setCamera(left);
    glideFrame = t < 1 ? requestAnimationFrame(step) : null;
  };
  glideFrame = requestAnimationFrame(step);
}
