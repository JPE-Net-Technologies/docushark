/**
 * Shape style capability resolution for the adapter layer (JP-33).
 *
 * Replaces the old hardcoded `SHAPE_CATEGORIES` map + the brittle
 * `isLibraryShape()` string heuristic in `styleProfileStore`. Capability is now
 * sourced from registry/metadata truth:
 *
 *   1. `shapeRegistry.getMetadata(type)` — authoritative for shapes that
 *      register metadata (the `file` shape + all library shapes).
 *   2. A small static fallback for the core shapes, which deliberately register
 *      no metadata (so they stay out of the library picker). This fallback is
 *      also what keeps the layer working in unit tests, where the registry and
 *      shape-library store are empty.
 *   3. `shapeLibraryStore.isLibraryShape(type)` as a last resort.
 *
 * Registry/store reads happen lazily *inside* the functions (never at module
 * load) so this module imports cleanly and degrades gracefully when those
 * stores have not been initialized yet.
 */

import { shapeRegistry } from '../../shapes/ShapeRegistry';
import { useShapeLibraryStore } from '../shapeLibraryStore';

/**
 * Core shapes that support labels but register no metadata. Also the source of
 * truth in the (registry-empty) test environment.
 */
const STATIC_LABEL_TYPES = new Set(['rectangle', 'ellipse', 'connector', 'group']);

/** Core shapes that support icons but register no metadata. */
const STATIC_ICON_TYPES = new Set(['rectangle', 'ellipse']);

/**
 * Whether `type` is a registered library shape. Wrapped in try/catch so that a
 * not-yet-initialized store (e.g. in tests) degrades to `false` rather than
 * throwing.
 */
function isLibraryShapeType(type: string): boolean {
  try {
    return useShapeLibraryStore.getState().isLibraryShape(type);
  } catch {
    return false;
  }
}

/** Whether shapes of this type carry a styleable label. */
export function shapeSupportsLabel(type: string): boolean {
  const meta = shapeRegistry.getMetadata(type);
  if (meta) return meta.supportsLabel;
  if (STATIC_LABEL_TYPES.has(type)) return true;
  return isLibraryShapeType(type);
}

/** Whether shapes of this type carry a styleable icon. */
export function shapeSupportsIcon(type: string): boolean {
  const meta = shapeRegistry.getMetadata(type);
  if (meta) return meta.supportsIcon;
  if (STATIC_ICON_TYPES.has(type)) return true;
  return isLibraryShapeType(type);
}
