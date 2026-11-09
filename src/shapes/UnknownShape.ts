/**
 * Stand-in handler for a shape type this build doesn't know (DSK-235).
 *
 * A newer version can write shape types an older one has never seen, and older
 * versions stay in use for a while: a cached PWA, a second tab, production
 * lagging staging. The older build has to keep such a shape intact and keep
 * working around it. It can't draw the real thing, so it measures the shape from
 * the fields every shape type keeps (`x`, `y` as the centre, `width`, `height`),
 * outlines it, and says it needs a newer version. Creating one is refused:
 * nothing in this build should mint a type it doesn't know.
 */

import { Box } from '../math/Box';
import type { Vec2 } from '../math/Vec2';
import type { Shape, Handle } from './Shape';
import type { ShapeHandler } from './ShapeRegistry';

/** Width and height given to an unknown shape that carries no usable size. */
export const UNKNOWN_SHAPE_FALLBACK_SIZE = 40;

/** What the outline says, when the shape is big enough to hold it. */
export const UNKNOWN_SHAPE_LABEL = 'Needs a newer DocuShark';

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** World-space bounds of a shape of unknown type, from its centre and size. */
export function unknownShapeBounds(shape: Shape): Box {
  const fields = shape as unknown as Record<string, unknown>;
  const cx = finite(fields['x'], 0);
  const cy = finite(fields['y'], 0);
  const width = Math.max(1, Math.abs(finite(fields['width'], UNKNOWN_SHAPE_FALLBACK_SIZE)));
  const height = Math.max(1, Math.abs(finite(fields['height'], UNKNOWN_SHAPE_FALLBACK_SIZE)));
  return new Box(cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2);
}

export const unknownShapeHandler: ShapeHandler = {
  render(ctx: CanvasRenderingContext2D, shape: Shape): void {
    const b = unknownShapeBounds(shape);
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    // Mid-grey reads on both the light and the dark canvas.
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.9)';
    ctx.fillStyle = 'rgba(128, 128, 128, 0.08)';
    ctx.fillRect(b.minX, b.minY, b.width, b.height);
    ctx.strokeRect(b.minX, b.minY, b.width, b.height);
    if (b.width >= 80 && b.height >= 20) {
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(128, 128, 128, 0.95)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(UNKNOWN_SHAPE_LABEL, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.width - 8);
    }
    ctx.restore();
  },

  hitTest(shape: Shape, worldPoint: Vec2): boolean {
    return unknownShapeBounds(shape).containsPoint(worldPoint);
  },

  getBounds(shape: Shape): Box {
    return unknownShapeBounds(shape);
  },

  // No resize or rotate handles: this build doesn't know the shape's geometry
  // beyond its box. It can still be selected, moved and deleted.
  getHandles(): Handle[] {
    return [];
  },

  create(): Shape {
    throw new Error('Cannot create a shape of a type this build does not know');
  },
};
