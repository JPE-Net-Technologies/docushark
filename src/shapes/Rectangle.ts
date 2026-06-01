/**
 * Rectangle — defined declaratively via the shared ShapeDefinition factory
 * (JP-160). The data type (`RectangleShape`) and persisted `type: 'rectangle'`
 * are unchanged; only the handler is now generated. Rectangle is a pure box:
 * bounds/hit/handles use the factory defaults; the path honors `cornerRadius`.
 */

import { shapeRegistry } from './ShapeRegistry';
import { RectangleShape, DEFAULT_RECTANGLE } from './Shape';
import type { ShapeMetadata } from './ShapeMetadata';
import { type ShapeDefinition, createStandardAnchors } from './library/ShapeLibraryTypes';
import { createShapeHandler } from './library/LibraryShapeHandler';
import { RECT_LABEL_SPEC } from './label/specs';

const rectangleMetadata: ShapeMetadata = {
  type: 'rectangle',
  name: 'Rectangle',
  category: 'basic',
  icon: '▭',
  properties: [],
  supportsLabel: true,
  supportsIcon: true,
  defaultWidth: DEFAULT_RECTANGLE.width,
  defaultHeight: DEFAULT_RECTANGLE.height,
};

export const rectangleDefinition: ShapeDefinition<RectangleShape> = {
  type: 'rectangle',
  metadata: rectangleMetadata,
  // Box hit test matches the historical rectangle (AABB + stroke padding).
  hitTestMode: 'bounds',
  labelSpec: RECT_LABEL_SPEC,
  anchors: createStandardAnchors(),
  pathBuilder: (width, height, shape) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const cornerRadius = shape ? shape.cornerRadius : 0;
    if (cornerRadius > 0) {
      const r = Math.min(cornerRadius, hw, hh);
      path.moveTo(-hw + r, -hh);
      path.lineTo(hw - r, -hh);
      path.arcTo(hw, -hh, hw, -hh + r, r);
      path.lineTo(hw, hh - r);
      path.arcTo(hw, hh, hw - r, hh, r);
      path.lineTo(-hw + r, hh);
      path.arcTo(-hw, hh, -hw, hh - r, r);
      path.lineTo(-hw, -hh + r);
      path.arcTo(-hw, -hh, -hw + r, -hh, r);
      path.closePath();
    } else {
      path.rect(-hw, -hh, width, height);
    }
    return path;
  },
  create: (position, id): RectangleShape => ({
    id,
    type: 'rectangle',
    x: position.x,
    y: position.y,
    rotation: DEFAULT_RECTANGLE.rotation,
    opacity: DEFAULT_RECTANGLE.opacity,
    locked: DEFAULT_RECTANGLE.locked,
    visible: DEFAULT_RECTANGLE.visible,
    fill: DEFAULT_RECTANGLE.fill,
    stroke: DEFAULT_RECTANGLE.stroke,
    strokeWidth: DEFAULT_RECTANGLE.strokeWidth,
    width: DEFAULT_RECTANGLE.width,
    height: DEFAULT_RECTANGLE.height,
    cornerRadius: DEFAULT_RECTANGLE.cornerRadius,
  }),
};

/** Generated handler for the rectangle shape. */
export const rectangleHandler = createShapeHandler(rectangleDefinition);

// Register the rectangle handler (no metadata → stays out of the library picker).
shapeRegistry.register('rectangle', rectangleHandler);
