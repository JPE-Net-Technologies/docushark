/**
 * Shared connector-binding helpers for import adapters (JP-196).
 *
 * Every import on-ramp (Excalidraw, drawio, Mermaid, PlantUML, …) faces the
 * same problem: a source format binds an arrow to a node, and we must decide
 * *where on the node's boundary* the connector hitches. Binding only the shape
 * id leaves the endpoint at the shape **centre** (DocuShark's connector model
 * resolves an unset anchor to the `'center'` anchor at local 0,0), so the line
 * visibly runs into the middle of the box. This module centralises the
 * "nearest hitch" rule so it's identical across adapters.
 */

import type { AnchorPosition } from '../Shape';

/**
 * A target shape's bounding box, in whatever coordinate space the adapter is
 * working in (source-scene coords are fine — the rule is scale/space-agnostic
 * as long as `box` and the `toward` point share a space).
 */
export interface AnchorBox {
  /** Centre of the box. */
  cx: number;
  cy: number;
  /** Full width / height of the box. */
  width: number;
  height: number;
  /** Rotation in radians, clockwise. Defaults to 0. */
  rotation?: number;
}

/** Build an {@link AnchorBox} from a top-left-anchored rect (the common case). */
export function boxFromTopLeft(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation = 0
): AnchorBox {
  return { cx: x + width / 2, cy: y + height / 2, width, height, rotation };
}

/**
 * Pick the boundary anchor (`top` / `right` / `bottom` / `left`) of `box` that
 * faces the point `toward` — the side an imported connector should hitch to
 * instead of the shape centre.
 *
 * `toward` is normally the connector's **other** endpoint, so the binding lands
 * on the side the rest of the connector runs to (the user's "project along the
 * line from the connector's other end to the boundary" rule). The direction is
 * normalised by the box's half-extents, so aspect ratio is respected — a wide
 * box attaches on left/right far more readily than top/bottom — and the box's
 * rotation is undone first so a rotated node still hitches on the visually
 * correct face.
 *
 * The four returned sides are exactly the mid-edge anchors every box shape
 * exposes via `createStandardAnchors`, so the connector resolves to that edge
 * at render time (`getConnectorStartPoint` / `getConnectorEndPoint`).
 */
export function nearestEdgeAnchor(
  box: AnchorBox,
  toward: { x: number; y: number }
): AnchorPosition {
  let dx = toward.x - box.cx;
  let dy = toward.y - box.cy;

  const angle = box.rotation ?? 0;
  if (angle) {
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    [dx, dy] = [dx * cos - dy * sin, dx * sin + dy * cos];
  }

  const nx = dx / Math.max(box.width / 2, 1e-6);
  const ny = dy / Math.max(box.height / 2, 1e-6);

  if (Math.abs(nx) >= Math.abs(ny)) return nx >= 0 ? 'right' : 'left';
  return ny >= 0 ? 'bottom' : 'top';
}
