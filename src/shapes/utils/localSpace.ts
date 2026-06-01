/**
 * Rotation-aware local⇄world geometry shared by shape handlers.
 *
 * This logic was previously re-declared privately in `Rectangle.ts` and
 * `LibraryShapeHandler.ts` (and mirrored in `Ellipse.ts`). Centralizing it
 * removes the duplication and gives every handler one consistent transform.
 *
 * Convention: a shape's `(x, y)` is its center, `rotation` is in radians, and
 * corners are derived from explicit `width`/`height` (callers pass `radius*2`
 * for ellipses).
 */

import { Vec2 } from '../../math/Vec2';

/** Minimal positioned/rotated shape contract these helpers need. */
export interface Positioned {
  x: number;
  y: number;
  rotation: number;
}

/** Transform a local-space point to world space (rotate then translate). */
export function localToWorld(local: Vec2, shape: Positioned): Vec2 {
  const rotated = local.rotate(shape.rotation);
  return new Vec2(rotated.x + shape.x, rotated.y + shape.y);
}

/** Transform a world-space point to local space (translate then un-rotate). */
export function worldToLocal(world: Vec2, shape: Positioned): Vec2 {
  const translated = new Vec2(world.x - shape.x, world.y - shape.y);
  return translated.rotate(-shape.rotation);
}

/** The four corners of a `width`×`height` box centered at the origin. */
export function getLocalCorners(width: number, height: number): Vec2[] {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return [
    new Vec2(-halfWidth, -halfHeight), // top-left
    new Vec2(halfWidth, -halfHeight), // top-right
    new Vec2(halfWidth, halfHeight), // bottom-right
    new Vec2(-halfWidth, halfHeight), // bottom-left
  ];
}

/** The four corners of a shape's box in world space (accounts for rotation). */
export function getWorldCorners(shape: Positioned, width: number, height: number): Vec2[] {
  return getLocalCorners(width, height).map((corner) => localToWorld(corner, shape));
}
