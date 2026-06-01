import { Vec2 } from '../math/Vec2';
import { Box } from '../math/Box';
import { ShapeHandler, shapeRegistry } from './ShapeRegistry';
import { TextShape, Handle, HandleType, DEFAULT_TEXT } from './Shape';
import { isAutoColor } from '../engine/ContrastResolver';
import { getRenderContext } from '../engine/RenderContext';

/**
 * Transform a local point to world space.
 */
function localToWorld(local: Vec2, shape: TextShape): Vec2 {
  const rotated = local.rotate(shape.rotation);
  return new Vec2(rotated.x + shape.x, rotated.y + shape.y);
}

/**
 * Transform a world point to local space.
 */
function worldToLocal(world: Vec2, shape: TextShape): Vec2 {
  const translated = new Vec2(world.x - shape.x, world.y - shape.y);
  return translated.rotate(-shape.rotation);
}

/**
 * Wrap text to fit within a given width.
 * Returns an array of lines.
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontSize: number,
  fontFamily: string
): string[] {
  // Set up font for measurement
  ctx.font = `${fontSize}px ${fontFamily}`;

  const paragraphs = text.split('\n');
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);

      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : [''];
}

/**
 * Text shape handler implementation.
 */
export const textHandler: ShapeHandler<TextShape> = {
  /**
   * Render text to the canvas context.
   */
  render(ctx: CanvasRenderingContext2D, shape: TextShape): void {
    const { x, y, text, fontSize, fontFamily, textAlign, verticalAlign, rotation, fill, opacity, width, height } = shape;

    if (!text) return;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(x, y);
    ctx.rotate(rotation);

    // Set up text style
    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = textAlign;

    // Shape's x,y is at center, so offset to top-left corner first
    const halfWidth = width / 2;
    const halfHeight = height / 2;

    // Calculate text position based on horizontal alignment
    // Starting from -halfWidth (left edge) to +halfWidth (right edge)
    let textX = -halfWidth; // left align
    if (textAlign === 'center') {
      textX = 0; // center of shape
    } else if (textAlign === 'right') {
      textX = halfWidth; // right edge
    }

    // Wrap text to fit width
    const lines = wrapText(ctx, text, width, fontSize, fontFamily);
    const lineHeight = fontSize * 1.4;
    const totalTextHeight = lines.length * lineHeight;

    // Calculate vertical offset based on verticalAlign
    // Starting from -halfHeight (top edge)
    let textY = -halfHeight; // top align
    if (verticalAlign === 'middle') {
      textY = -totalTextHeight / 2;
    } else if (verticalAlign === 'bottom') {
      textY = halfHeight - totalTextHeight;
    }

    let resolvedFill = fill;
    if (fill && isAutoColor(fill)) {
      const rc = getRenderContext();
      if (rc) {
        resolvedFill = rc.contrastCache.resolve(
          { x: shape.x, y: shape.y },
          rc.shapes, rc.shapeOrder, rc.pageBackground, shape.id
        );
      } else {
        resolvedFill = '#000000';
      }
    }

    if (resolvedFill) {
      ctx.fillStyle = resolvedFill;
      lines.forEach((line, index) => {
        ctx.fillText(line, textX, textY + index * lineHeight);
      });
    }

    ctx.restore();
  },

  /**
   * Test if a world point is inside the text bounding box.
   */
  hitTest(shape: TextShape, worldPoint: Vec2): boolean {
    const local = worldToLocal(worldPoint, shape);
    const halfWidth = shape.width / 2;
    const halfHeight = shape.height / 2;

    return local.x >= -halfWidth && local.x <= halfWidth && local.y >= -halfHeight && local.y <= halfHeight;
  },

  /**
   * Get the axis-aligned bounding box of the text.
   */
  getBounds(shape: TextShape): Box {
    const halfWidth = shape.width / 2;
    const halfHeight = shape.height / 2;

    // Get corners in local space (text is positioned from top-left)
    const corners = [
      new Vec2(0, 0),
      new Vec2(shape.width, 0),
      new Vec2(shape.width, shape.height),
      new Vec2(0, shape.height),
    ];

    // Adjust for center positioning and transform to world
    const worldCorners = corners.map((c) => {
      const centered = new Vec2(c.x - halfWidth, c.y - halfHeight);
      return localToWorld(centered, shape);
    });

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    for (const corner of worldCorners) {
      minX = Math.min(minX, corner.x);
      minY = Math.min(minY, corner.y);
      maxX = Math.max(maxX, corner.x);
      maxY = Math.max(maxY, corner.y);
    }

    return new Box(minX, minY, maxX, maxY);
  },

  /**
   * Get resize handles for the text box.
   */
  getHandles(shape: TextShape): Handle[] {
    const halfWidth = shape.width / 2;
    const halfHeight = shape.height / 2;
    const rotationHandleOffset = 30;

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

    return localHandles.map((h) => {
      const world = localToWorld(new Vec2(h.x, h.y), shape);
      return { type: h.type, x: world.x, y: world.y, cursor: h.cursor };
    });
  },

  /**
   * Create a new text shape at the given position.
   */
  create(position: Vec2, id: string): TextShape {
    return {
      id,
      type: 'text',
      x: position.x,
      y: position.y,
      text: 'Text',
      fontSize: DEFAULT_TEXT.fontSize,
      fontFamily: DEFAULT_TEXT.fontFamily,
      textAlign: DEFAULT_TEXT.textAlign,
      verticalAlign: DEFAULT_TEXT.verticalAlign,
      width: DEFAULT_TEXT.width,
      height: DEFAULT_TEXT.height,
      rotation: DEFAULT_TEXT.rotation,
      opacity: DEFAULT_TEXT.opacity,
      locked: DEFAULT_TEXT.locked,
      visible: DEFAULT_TEXT.visible,
      fill: 'auto',
      stroke: DEFAULT_TEXT.stroke,
      strokeWidth: DEFAULT_TEXT.strokeWidth,
    };
  },

  /**
   * In-place edit target. Text shapes edit their `text` field; the inline
   * editor keeps its bespoke top-left anchoring for text, so the worldRect here
   * is informational (used for the capability check and fallback sizing).
   */
  getLabelEditTarget(shape: TextShape) {
    const align: 'left' | 'center' | 'right' =
      shape.textAlign === 'center' || shape.textAlign === 'right' ? shape.textAlign : 'left';
    return {
      field: 'text' as const,
      worldRect: { cx: shape.x, cy: shape.y, width: shape.width, height: shape.height },
      fontSize: shape.fontSize,
      align,
      rotation: shape.rotation,
    };
  },
};

// Register the text handler
shapeRegistry.register('text', textHandler);
