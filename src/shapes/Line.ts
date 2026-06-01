import { Vec2 } from '../math/Vec2';
import { Box } from '../math/Box';
import { ShapeHandler, shapeRegistry } from './ShapeRegistry';
import {
  LineShape,
  Handle,
  HandleType,
  DEFAULT_LINE,
} from './Shape';
import { renderLabel } from './label/renderLabel';
import { LINE_LABEL_SPEC } from './label/specs';

/**
 * Arrow head size relative to stroke width.
 */
const ARROW_SIZE_MULTIPLIER = 4;

/**
 * Calculate the distance from a point to a line segment.
 */
function pointToLineDistance(point: Vec2, lineStart: Vec2, lineEnd: Vec2): number {
  const lineVec = lineEnd.subtract(lineStart);
  const lineLength = lineVec.length();

  if (lineLength === 0) {
    return point.subtract(lineStart).length();
  }

  // Project point onto line, clamping to segment
  const t = Math.max(0, Math.min(1,
    point.subtract(lineStart).dot(lineVec) / (lineLength * lineLength)
  ));

  const projection = lineStart.add(lineVec.multiply(t));
  return point.subtract(projection).length();
}

/**
 * Draw an arrow head at the given position pointing in the direction.
 */
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  position: Vec2,
  direction: Vec2,
  size: number
): void {
  const normalizedDir = direction.normalize();
  const perpendicular = new Vec2(-normalizedDir.y, normalizedDir.x);

  // Arrow head points
  const tip = position;
  const back = position.subtract(normalizedDir.multiply(size));
  const left = back.add(perpendicular.multiply(size * 0.5));
  const right = back.subtract(perpendicular.multiply(size * 0.5));

  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(left.x, left.y);
  ctx.lineTo(right.x, right.y);
  ctx.closePath();
  ctx.fill();
}

/**
 * Line shape handler implementation.
 */
export const lineHandler: ShapeHandler<LineShape> = {
  /**
   * Render a line to the canvas context.
   * Handles rotation, stroke, and arrows.
   */
  render(ctx: CanvasRenderingContext2D, shape: LineShape): void {
    const { x, y, x2, y2, rotation, stroke, strokeWidth, opacity, startArrow, endArrow } = shape;

    ctx.save();

    // Set opacity
    ctx.globalAlpha = opacity;

    // Calculate center point for rotation
    const centerX = (x + x2) / 2;
    const centerY = (y + y2) / 2;

    // Transform to shape's local coordinate system
    ctx.translate(centerX, centerY);
    ctx.rotate(rotation);
    ctx.translate(-centerX, -centerY);

    // Line direction
    const start = new Vec2(x, y);
    const end = new Vec2(x2, y2);
    const direction = end.subtract(start);
    const arrowSize = strokeWidth * ARROW_SIZE_MULTIPLIER;

    // Adjust line endpoints if arrows are present
    let lineStart = start;
    let lineEnd = end;

    if (startArrow && direction.length() > arrowSize) {
      lineStart = start.add(direction.normalize().multiply(arrowSize * 0.8));
    }
    if (endArrow && direction.length() > arrowSize) {
      lineEnd = end.subtract(direction.normalize().multiply(arrowSize * 0.8));
    }

    // Draw the line
    if (stroke && strokeWidth > 0) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      ctx.moveTo(lineStart.x, lineStart.y);
      ctx.lineTo(lineEnd.x, lineEnd.y);
      ctx.stroke();

      // Draw arrows
      if (stroke) {
        ctx.fillStyle = stroke;

        if (startArrow && direction.length() > 0) {
          // Arrow pointing toward start
          drawArrowHead(ctx, start, direction.multiply(-1), arrowSize);
        }

        if (endArrow && direction.length() > 0) {
          // Arrow pointing toward end
          drawArrowHead(ctx, end, direction, arrowSize);
        }
      }
    }

    // Draw the midpoint label via the shared label engine.
    if (shape.label) {
      const lineLength = end.subtract(start).length();
      const labelFontSize = shape.labelFontSize || LINE_LABEL_SPEC.defaultFontSize;
      ctx.save();
      ctx.translate(centerX, centerY);
      renderLabel(ctx, {
        text: shape.label,
        spec: LINE_LABEL_SPEC,
        overflow: shape.labelOverflow,
        boxWidth: Math.max(lineLength, 60),
        boxHeight: labelFontSize * 2,
        fontSize: labelFontSize,
        color: shape.labelColor || stroke || '#000000',
        background: shape.labelBackground,
        offsetX: shape.labelOffsetX || 0,
        offsetY: shape.labelOffsetY || 0,
      });
      ctx.restore();
    }

    ctx.restore();
  },

  /**
   * Test if a world point is near the line.
   * Uses a hit tolerance based on stroke width.
   */
  hitTest(shape: LineShape, worldPoint: Vec2): boolean {
    const { x, y, x2, y2, rotation, strokeWidth } = shape;

    // Calculate center point for rotation
    const centerX = (x + x2) / 2;
    const centerY = (y + y2) / 2;
    const center = new Vec2(centerX, centerY);

    // Transform point to account for line rotation
    let testPoint = worldPoint;
    if (rotation !== 0) {
      // Rotate the test point around the line center by negative rotation
      const relative = worldPoint.subtract(center);
      const rotated = relative.rotate(-rotation);
      testPoint = rotated.add(center);
    }

    const start = new Vec2(x, y);
    const end = new Vec2(x2, y2);

    // Calculate hit tolerance (minimum of 5 pixels or stroke width)
    const hitTolerance = Math.max(5, strokeWidth);

    const distance = pointToLineDistance(testPoint, start, end);
    return distance <= hitTolerance;
  },

  /**
   * Get the axis-aligned bounding box of the line.
   * Accounts for rotation and arrow heads.
   */
  getBounds(shape: LineShape): Box {
    const { x, y, x2, y2, rotation, strokeWidth, startArrow, endArrow } = shape;

    // Get line endpoints
    let points: Vec2[] = [new Vec2(x, y), new Vec2(x2, y2)];

    // Add padding for arrows
    const arrowSize = strokeWidth * ARROW_SIZE_MULTIPLIER;
    const direction = points[1]!.subtract(points[0]!).normalize();

    if (startArrow && direction.length() > 0) {
      const arrowBack = points[0]!.subtract(direction.multiply(arrowSize));
      points.push(arrowBack);
    }
    if (endArrow && direction.length() > 0) {
      const arrowBack = points[1]!.add(direction.multiply(arrowSize));
      points.push(arrowBack);
    }

    // Apply rotation if needed
    if (rotation !== 0) {
      const centerX = (x + x2) / 2;
      const centerY = (y + y2) / 2;
      const center = new Vec2(centerX, centerY);

      points = points.map(p => {
        const relative = p.subtract(center);
        const rotated = relative.rotate(rotation);
        return rotated.add(center);
      });
    }

    // Find bounds
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }

    // Add stroke width padding
    const padding = strokeWidth / 2;

    return new Box(minX - padding, minY - padding, maxX + padding, maxY + padding);
  },

  /**
   * Get the resize handles for the line.
   * Returns handles at start and end points.
   */
  getHandles(shape: LineShape): Handle[] {
    const { x, y, x2, y2, rotation } = shape;

    const handles: Array<{ type: HandleType; x: number; y: number; cursor: string }> = [
      { type: 'top-left', x, y, cursor: 'crosshair' }, // Start point
      { type: 'bottom-right', x: x2, y: y2, cursor: 'crosshair' }, // End point
    ];

    // Apply rotation if needed
    if (rotation !== 0) {
      const centerX = (x + x2) / 2;
      const centerY = (y + y2) / 2;
      const center = new Vec2(centerX, centerY);

      return handles.map((h) => {
        const point = new Vec2(h.x, h.y);
        const relative = point.subtract(center);
        const rotated = relative.rotate(rotation);
        const world = rotated.add(center);
        return {
          type: h.type,
          x: world.x,
          y: world.y,
          cursor: h.cursor,
        };
      });
    }

    return handles;
  },

  /**
   * Create a new line at the given position.
   */
  create(position: Vec2, id: string): LineShape {
    return {
      id,
      type: 'line',
      x: position.x,
      y: position.y,
      x2: position.x + 100, // Default 100 units long
      y2: position.y,
      rotation: DEFAULT_LINE.rotation,
      opacity: DEFAULT_LINE.opacity,
      locked: DEFAULT_LINE.locked,
      visible: DEFAULT_LINE.visible,
      fill: DEFAULT_LINE.fill,
      stroke: DEFAULT_LINE.stroke,
      strokeWidth: DEFAULT_LINE.strokeWidth,
      startArrow: DEFAULT_LINE.startArrow,
      endArrow: DEFAULT_LINE.endArrow,
    };
  },

  /**
   * In-place label edit target: the line's midpoint (JP-102 line labels).
   * The midpoint coincides with the rotation center, so it is stable under the
   * line's `rotation` field.
   */
  getLabelEditTarget(shape: LineShape) {
    const cx = (shape.x + shape.x2) / 2;
    const cy = (shape.y + shape.y2) / 2;
    const fontSize = shape.labelFontSize || LINE_LABEL_SPEC.defaultFontSize;
    return {
      field: 'label' as const,
      worldRect: {
        cx: cx + (shape.labelOffsetX || 0),
        cy: cy + (shape.labelOffsetY || 0),
        width: 120,
        height: fontSize * 1.5,
      },
      fontSize,
      align: 'center' as const,
      rotation: shape.rotation,
    };
  },
};

// Register the line handler
shapeRegistry.register('line', lineHandler);
