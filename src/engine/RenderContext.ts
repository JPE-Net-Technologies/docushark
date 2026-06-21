import { Shape } from '../shapes/Shape';
import { Box } from '../math/Box';
import { ContrastCache } from './ContrastResolver';

/**
 * Per-frame state shared between the Renderer and shape handlers.
 *
 * Shape handlers have a fixed `(ctx, shape) => void` signature, so any
 * extra information they need at render time (currently only the
 * contrast resolver) is exposed via this module-level slot. The Renderer
 * sets it at the start of each frame and clears it at the end; handlers
 * read it when they encounter the AUTO color sentinel.
 *
 * Outside a render frame, `getRenderContext()` returns null and handlers
 * fall back to their pre-AUTO behavior (treating "auto" as a literal
 * unknown color, which most paths already handle gracefully).
 */
export interface RenderContext {
  /** Shape map for the frame currently being rendered. */
  shapes: Record<string, Shape>;
  /** Z-ordered shape ids (first = bottom). */
  shapeOrder: string[];
  /** Page/canvas background color used as the contrast fallback. */
  pageBackground: string;
  /** Per-frame memoization cache for contrast lookups. */
  contrastCache: ContrastCache;
  /**
   * World-space boxes of every connector label without an opaque pill, across
   * the whole frame. Each connector breaks its line at ALL of these (not just
   * its own), so no line is drawn through any label's text (JP-353). Computed
   * once per frame by the renderer/exporter after the context is set.
   */
  connectorLabelGapBoxes?: Box[];
}

let current: RenderContext | null = null;

export function setRenderContext(ctx: RenderContext | null): void {
  current = ctx;
}

export function getRenderContext(): RenderContext | null {
  return current;
}
