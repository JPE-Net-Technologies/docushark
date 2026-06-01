/**
 * Types for defining library shapes.
 *
 * Library shapes are defined declaratively with path builders and anchor definitions.
 * The LibraryShapeHandler factory creates ShapeHandler implementations from these definitions.
 */

import type { ShapeMetadata } from '../ShapeMetadata';
import type { AnchorPosition, LibraryShape, Handle, BaseShape } from '../Shape';
import type { Vec2 } from '../../math/Vec2';
import type { Box } from '../../math/Box';
import type { LabelSpec } from '../label/LabelSpec';

/**
 * Path builder function that creates a Path2D from shape dimensions.
 * The path should be centered at origin (0, 0).
 *
 * @param width - Shape width in world units
 * @param height - Shape height in world units
 * @returns A Path2D representing the shape geometry
 */
export type PathBuilder = (width: number, height: number) => Path2D;

/**
 * Custom render function for shapes that need specialized rendering.
 * Called after the path is drawn but before labels/icons.
 *
 * @param ctx - Canvas context (already translated to shape center, rotated)
 * @param shape - The shape being rendered
 * @param path - The path that was built
 */
export type CustomRenderFunction = (
  ctx: CanvasRenderingContext2D,
  shape: LibraryShape,
  path: Path2D
) => void;

/**
 * Anchor definition for connector attachment points.
 * Positions are calculated relative to shape center.
 */
export interface AnchorDefinition {
  /** Semantic position identifier (e.g., 'top', 'right', 'attr-0-left') */
  position: AnchorPosition;
  /** X offset calculator from shape center */
  x: (width: number, height: number) => number;
  /** Y offset calculator from shape center */
  y: (width: number, height: number) => number;
}

/**
 * Dynamic anchor calculator function.
 * Use when anchors depend on shape instance data (e.g., member count in ERD entities).
 *
 * @param shape - The shape instance to calculate anchors for
 * @param width - Shape width in world units
 * @param height - Shape height in world units
 * @returns Array of anchor definitions for this specific shape instance
 */
export type DynamicAnchorsFunction = (
  shape: LibraryShape,
  width: number,
  height: number
) => AnchorDefinition[];

/**
 * Definition for a library shape type.
 *
 * This declarative structure is used to generate ShapeHandlers at runtime.
 * It includes:
 * - Shape metadata for UI (name, icon, category, properties)
 * - Path builder for rendering the shape geometry
 * - Anchor definitions for connector attachment
 */
export interface ShapeDefinition<T extends BaseShape = LibraryShape> {
  /** Shape type identifier (e.g., 'rectangle', 'diamond', 'terminator'). */
  type: string;

  /** Metadata for UI rendering (PropertyPanel, ShapePicker). */
  metadata: ShapeMetadata;

  /**
   * Path builder. Returns a Path2D centered at origin for the given bounding
   * size. Receives the shape instance for data-driven geometry (e.g. a
   * rectangle's corner radius); simple shapes can ignore it.
   */
  pathBuilder: (width: number, height: number, shape?: T) => Path2D;

  /** Anchor points for connector attachment, relative to shape center. */
  anchors: AnchorDefinition[];

  /**
   * Custom hit test mode.
   * - 'path': Path2D.isPointInPath (default, accurate for complex shapes)
   * - 'bounds': bounding box (faster, less accurate)
   */
  hitTestMode?: 'path' | 'bounds';

  /**
   * Custom render function for specialized rendering. Called after fill/stroke
   * but before icons/labels (compartments, member lists, etc.).
   */
  customRender?: (ctx: CanvasRenderingContext2D, shape: T, path: Path2D) => void;

  /** If true, disables default label rendering (customRender handles text). */
  customLabelRendering?: boolean;

  /**
   * Dynamic anchor calculator. Use when anchors depend on instance data (e.g.
   * member count in ERD entities); called instead of the static `anchors`.
   */
  dynamicAnchors?: (shape: T, width: number, height: number) => AnchorDefinition[];

  /** Extra handles appended to the standard resize/rotation handles. */
  customHandles?: (shape: T) => Handle[];

  // --- Generalization hooks (JP-160). All optional; absent ⇒ box behavior. ---

  /** Bounding-box size for a shape. Default: `{ shape.width, shape.height }`. */
  getSize?: (shape: T) => { width: number; height: number };

  /** Replace the default (box / path) hit test entirely. */
  customHitTest?: (shape: T, worldPoint: Vec2) => boolean;

  /** Replace the default corner-derived bounds entirely. */
  customBounds?: (shape: T) => Box;

  /** Replace the default 8-resize + rotation handle set entirely. */
  handles?: (shape: T) => Handle[];

  /** Construct the correctly-typed shape (default: a LibraryShape). */
  create?: (position: Vec2, id: string) => T;

  /** Label spec override (default: the library label spec). */
  labelSpec?: LabelSpec;
}

/**
 * The library-shape specialization. Unchanged surface for the ~40 built-in
 * library shapes, which are all `ShapeDefinition<LibraryShape>`.
 */
export type LibraryShapeDefinition = ShapeDefinition<LibraryShape>;

/**
 * Standard 5-anchor pattern for most shapes.
 * Provides center and 4 cardinal directions.
 */
export function createStandardAnchors(): AnchorDefinition[] {
  return [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'top', x: () => 0, y: (_, h) => -h / 2 },
    { position: 'right', x: (w) => w / 2, y: () => 0 },
    { position: 'bottom', x: () => 0, y: (_, h) => h / 2 },
    { position: 'left', x: (w) => -w / 2, y: () => 0 },
  ];
}

/**
 * Diamond-specific anchors (at the 4 points).
 */
export function createDiamondAnchors(): AnchorDefinition[] {
  return [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'top', x: () => 0, y: (_, h) => -h / 2 },
    { position: 'right', x: (w) => w / 2, y: () => 0 },
    { position: 'bottom', x: () => 0, y: (_, h) => h / 2 },
    { position: 'left', x: (w) => -w / 2, y: () => 0 },
  ];
}

/**
 * Hexagon-specific anchors (6 points).
 */
export function createHexagonAnchors(): AnchorDefinition[] {
  return [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'top', x: () => 0, y: (_, h) => -h / 2 },
    { position: 'right', x: (w) => w / 2, y: () => 0 },
    { position: 'bottom', x: () => 0, y: (_, h) => h / 2 },
    { position: 'left', x: (w) => -w / 2, y: () => 0 },
  ];
}
