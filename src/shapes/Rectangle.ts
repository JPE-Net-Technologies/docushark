import { Vec2 } from '../math/Vec2';
import { Box } from '../math/Box';
import { ShapeHandler, shapeRegistry } from './ShapeRegistry';
import {
  RectangleShape,
  Handle,
  HandleType,
  Anchor,
  AnchorPosition,
  DEFAULT_RECTANGLE,
} from './Shape';
import { renderShapeIcons, isIconOnlyMode } from '../utils/iconRenderer';
import { localToWorld, worldToLocal, getWorldCorners } from './utils/localSpace';
import { renderLabel } from './label/renderLabel';
import { RECT_LABEL_SPEC } from './label/specs';

/**
 * Rectangle shape handler implementation.
 */
export const rectangleHandler: ShapeHandler<RectangleShape> = {
  /**
   * Render a rectangle to the canvas context.
   * Handles rotation, fill, stroke, rounded corners, and label.
   */
  render(ctx: CanvasRenderingContext2D, shape: RectangleShape): void {
    const { x, y, width, height, rotation, fill, stroke, strokeWidth, opacity, cornerRadius } =
      shape;

    ctx.save();

    // Set opacity
    ctx.globalAlpha = opacity;

    // Transform to shape's local coordinate system
    ctx.translate(x, y);
    ctx.rotate(rotation);

    // Draw the rectangle path
    const halfWidth = width / 2;
    const halfHeight = height / 2;

    ctx.beginPath();

    if (cornerRadius > 0) {
      // Rounded rectangle
      const r = Math.min(cornerRadius, halfWidth, halfHeight);
      ctx.moveTo(-halfWidth + r, -halfHeight);
      ctx.lineTo(halfWidth - r, -halfHeight);
      ctx.arcTo(halfWidth, -halfHeight, halfWidth, -halfHeight + r, r);
      ctx.lineTo(halfWidth, halfHeight - r);
      ctx.arcTo(halfWidth, halfHeight, halfWidth - r, halfHeight, r);
      ctx.lineTo(-halfWidth + r, halfHeight);
      ctx.arcTo(-halfWidth, halfHeight, -halfWidth, halfHeight - r, r);
      ctx.lineTo(-halfWidth, -halfHeight + r);
      ctx.arcTo(-halfWidth, -halfHeight, -halfWidth + r, -halfHeight, r);
    } else {
      // Sharp corners
      ctx.rect(-halfWidth, -halfHeight, width, height);
    }

    ctx.closePath();

    // Check if this is icon-only mode (skip fill/stroke)
    const iconOnly = isIconOnlyMode(shape);

    // Fill (skip in icon-only mode)
    if (fill && !iconOnly) {
      ctx.fillStyle = fill;
      ctx.fill();
    }

    // Stroke (skip in icon-only mode)
    if (stroke && strokeWidth > 0 && !iconOnly) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }

    // Draw icons using the IconRenderer
    const hasIcon = shape.iconId || (shape.icons && shape.icons.length > 0);
    if (hasIcon) {
      const defaultColor = stroke || '#333333';
      renderShapeIcons(ctx, shape, { halfWidth, halfHeight }, defaultColor);
    }

    // Draw label if present (via the shared label engine)
    if (shape.label) {
      renderLabel(ctx, {
        text: shape.label,
        spec: RECT_LABEL_SPEC,
        overflow: shape.labelOverflow,
        boxWidth: width,
        boxHeight: height,
        fontSize: shape.labelFontSize || RECT_LABEL_SPEC.defaultFontSize,
        color: shape.labelColor || stroke || '#000000',
        background: shape.labelBackground,
        offsetX: shape.labelOffsetX || 0,
        offsetY: shape.labelOffsetY || 0,
      });
    }

    ctx.restore();
  },

  /**
   * Test if a world point is inside the rectangle.
   * Works correctly for rotated rectangles.
   */
  hitTest(shape: RectangleShape, worldPoint: Vec2): boolean {
    // Transform point to local space
    const local = worldToLocal(worldPoint, shape);

    const halfWidth = shape.width / 2;
    const halfHeight = shape.height / 2;

    // Add stroke width to hit area
    const strokePadding = shape.strokeWidth / 2;

    return (
      local.x >= -halfWidth - strokePadding &&
      local.x <= halfWidth + strokePadding &&
      local.y >= -halfHeight - strokePadding &&
      local.y <= halfHeight + strokePadding
    );
  },

  /**
   * Get the axis-aligned bounding box of the rectangle.
   * Accounts for rotation.
   */
  getBounds(shape: RectangleShape): Box {
    const corners = getWorldCorners(shape, shape.width, shape.height);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const corner of corners) {
      minX = Math.min(minX, corner.x);
      minY = Math.min(minY, corner.y);
      maxX = Math.max(maxX, corner.x);
      maxY = Math.max(maxY, corner.y);
    }

    // Add stroke width padding
    const padding = shape.strokeWidth / 2;

    return new Box(minX - padding, minY - padding, maxX + padding, maxY + padding);
  },

  /**
   * Get the resize and rotation handles for the rectangle.
   * Returns 8 resize handles (4 corners + 4 edge midpoints) + 1 rotation handle.
   */
  getHandles(shape: RectangleShape): Handle[] {
    const halfWidth = shape.width / 2;
    const halfHeight = shape.height / 2;

    // Rotation handle distance above the shape
    const rotationHandleOffset = 30;

    // Handle positions in local space
    const localHandles: Array<{ type: HandleType; x: number; y: number; cursor: string }> = [
      { type: 'top-left', x: -halfWidth, y: -halfHeight, cursor: 'nwse-resize' },
      { type: 'top', x: 0, y: -halfHeight, cursor: 'ns-resize' },
      { type: 'top-right', x: halfWidth, y: -halfHeight, cursor: 'nesw-resize' },
      { type: 'right', x: halfWidth, y: 0, cursor: 'ew-resize' },
      { type: 'bottom-right', x: halfWidth, y: halfHeight, cursor: 'nwse-resize' },
      { type: 'bottom', x: 0, y: halfHeight, cursor: 'ns-resize' },
      { type: 'bottom-left', x: -halfWidth, y: halfHeight, cursor: 'nesw-resize' },
      { type: 'left', x: -halfWidth, y: 0, cursor: 'ew-resize' },
      { type: 'rotation', x: 0, y: -halfHeight - rotationHandleOffset, cursor: 'grab' },
    ];

    // Transform to world space
    return localHandles.map((h) => {
      const world = localToWorld(new Vec2(h.x, h.y), shape);
      return {
        type: h.type,
        x: world.x,
        y: world.y,
        cursor: h.cursor,
      };
    });
  },

  /**
   * Create a new rectangle at the given position.
   */
  create(position: Vec2, id: string): RectangleShape {
    return {
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
    };
  },

  /**
   * Get the connector anchor points for the rectangle.
   * Returns 5 anchors: center and 4 edge midpoints.
   */
  getAnchors(shape: RectangleShape): Anchor[] {
    const { width, height } = shape;
    const halfWidth = width / 2;
    const halfHeight = height / 2;

    const localAnchors: Array<{ position: AnchorPosition; x: number; y: number }> = [
      { position: 'center', x: 0, y: 0 },
      { position: 'top', x: 0, y: -halfHeight },
      { position: 'right', x: halfWidth, y: 0 },
      { position: 'bottom', x: 0, y: halfHeight },
      { position: 'left', x: -halfWidth, y: 0 },
    ];

    return localAnchors.map((a) => {
      const world = localToWorld(new Vec2(a.x, a.y), shape);
      return {
        position: a.position,
        x: world.x,
        y: world.y,
      };
    });
  },

  /**
   * In-place label edit target: centered on the rectangle.
   */
  getLabelEditTarget(shape: RectangleShape) {
    return {
      field: 'label' as const,
      worldRect: { cx: shape.x, cy: shape.y, width: shape.width, height: shape.height },
      fontSize: shape.labelFontSize || RECT_LABEL_SPEC.defaultFontSize,
      align: 'center' as const,
      rotation: shape.rotation,
    };
  },
};

// Register the rectangle handler
shapeRegistry.register('rectangle', rectangleHandler);
