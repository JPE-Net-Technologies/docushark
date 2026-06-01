/**
 * Ellipse — defined declaratively via the shared ShapeDefinition factory
 * (JP-160). The data type (`EllipseShape`, with `radiusX`/`radiusY`) and
 * persisted `type: 'ellipse'` are unchanged. The ellipse is not a plain box, so
 * it overrides the factory's geometry: `getSize` maps radii to a bounding box,
 * and the parametric hit test / rotation-aware bounds / on-curve handles are
 * lifted verbatim from the previous bespoke handler to preserve exact behavior.
 */

import { Vec2 } from '../math/Vec2';
import { Box } from '../math/Box';
import { shapeRegistry } from './ShapeRegistry';
import { EllipseShape, Handle, HandleType, DEFAULT_ELLIPSE } from './Shape';
import type { ShapeMetadata } from './ShapeMetadata';
import { type ShapeDefinition, createStandardAnchors } from './library/ShapeLibraryTypes';
import { createShapeHandler } from './library/LibraryShapeHandler';
import { localToWorld, worldToLocal } from './utils/localSpace';
import { ELLIPSE_LABEL_SPEC } from './label/specs';

const ellipseMetadata: ShapeMetadata = {
  type: 'ellipse',
  name: 'Ellipse',
  category: 'basic',
  icon: '◯',
  properties: [],
  supportsLabel: true,
  supportsIcon: true,
  defaultWidth: DEFAULT_ELLIPSE.radiusX * 2,
  defaultHeight: DEFAULT_ELLIPSE.radiusY * 2,
};

export const ellipseDefinition: ShapeDefinition<EllipseShape> = {
  type: 'ellipse',
  metadata: ellipseMetadata,
  labelSpec: ELLIPSE_LABEL_SPEC,
  anchors: createStandardAnchors(),
  // Bounding box from radii (drives render, label, anchors via the factory).
  getSize: (shape) => ({ width: shape.radiusX * 2, height: shape.radiusY * 2 }),
  pathBuilder: (width, height) => {
    const path = new Path2D();
    path.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
    return path;
  },
  // Parametric point-in-ellipse test (lifted from the bespoke handler).
  customHitTest: (shape, worldPoint) => {
    const local = worldToLocal(worldPoint, shape);
    const strokePadding = shape.strokeWidth / 2;
    const rx = shape.radiusX + strokePadding;
    const ry = shape.radiusY + strokePadding;
    const nx = local.x / rx;
    const ny = local.y / ry;
    return nx * nx + ny * ny <= 1;
  },
  // Rotation-aware bounds: exact box when unrotated, else sample the boundary.
  customBounds: (shape) => {
    const { x, y, radiusX, radiusY, rotation, strokeWidth } = shape;
    const padding = strokeWidth / 2;
    if (rotation === 0) {
      return new Box(x - radiusX - padding, y - radiusY - padding, x + radiusX + padding, y + radiusY + padding);
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const samples = 64;
    for (let i = 0; i < samples; i++) {
      const t = (i / samples) * Math.PI * 2;
      const point = localToWorld(new Vec2(radiusX * Math.cos(t), radiusY * Math.sin(t)), shape);
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    return new Box(minX - padding, minY - padding, maxX + padding, maxY + padding);
  },
  // On-curve handles (diagonals sit on the ellipse, not at the bbox corners).
  handles: (shape): Handle[] => {
    const { radiusX, radiusY } = shape;
    const rotationHandleOffset = 30;
    const localHandles: Array<{ type: HandleType; x: number; y: number; cursor: string }> = [
      { type: 'top-left', x: -radiusX * Math.SQRT1_2, y: -radiusY * Math.SQRT1_2, cursor: 'nwse-resize' },
      { type: 'top', x: 0, y: -radiusY, cursor: 'ns-resize' },
      { type: 'top-right', x: radiusX * Math.SQRT1_2, y: -radiusY * Math.SQRT1_2, cursor: 'nesw-resize' },
      { type: 'right', x: radiusX, y: 0, cursor: 'ew-resize' },
      { type: 'bottom-right', x: radiusX * Math.SQRT1_2, y: radiusY * Math.SQRT1_2, cursor: 'nwse-resize' },
      { type: 'bottom', x: 0, y: radiusY, cursor: 'ns-resize' },
      { type: 'bottom-left', x: -radiusX * Math.SQRT1_2, y: radiusY * Math.SQRT1_2, cursor: 'nesw-resize' },
      { type: 'left', x: -radiusX, y: 0, cursor: 'ew-resize' },
      { type: 'rotation', x: 0, y: -radiusY - rotationHandleOffset, cursor: 'grab' },
    ];
    return localHandles.map((h) => {
      const world = localToWorld(new Vec2(h.x, h.y), shape);
      return { type: h.type, x: world.x, y: world.y, cursor: h.cursor };
    });
  },
  create: (position, id): EllipseShape => ({
    id,
    type: 'ellipse',
    x: position.x,
    y: position.y,
    rotation: DEFAULT_ELLIPSE.rotation,
    opacity: DEFAULT_ELLIPSE.opacity,
    locked: DEFAULT_ELLIPSE.locked,
    visible: DEFAULT_ELLIPSE.visible,
    fill: DEFAULT_ELLIPSE.fill,
    stroke: DEFAULT_ELLIPSE.stroke,
    strokeWidth: DEFAULT_ELLIPSE.strokeWidth,
    radiusX: DEFAULT_ELLIPSE.radiusX,
    radiusY: DEFAULT_ELLIPSE.radiusY,
  }),
};

/** Generated handler for the ellipse shape. */
export const ellipseHandler = createShapeHandler(ellipseDefinition);

// Register the ellipse handler (no metadata → stays out of the library picker).
shapeRegistry.register('ellipse', ellipseHandler);
