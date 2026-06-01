/**
 * Factory for creating ShapeHandler implementations from LibraryShapeDefinition.
 *
 * This enables declarative shape definitions that are automatically converted
 * to fully functional shape handlers for rendering, hit testing, and manipulation.
 */

import { Vec2 } from '../../math/Vec2';
import { Box } from '../../math/Box';
import type { ShapeHandler } from '../ShapeRegistry';
import type { LibraryShape, Handle, HandleType, Anchor } from '../Shape';
import { DEFAULT_LIBRARY_SHAPE } from '../Shape';
import type { LibraryShapeDefinition } from './ShapeLibraryTypes';
import { localToWorld, worldToLocal, getWorldCorners } from '../utils/localSpace';
import { renderLabel } from '../label/renderLabel';
import { LIBRARY_LABEL_SPEC } from '../label/specs';
import { renderShapeIcons, isIconOnlyMode } from '../../utils/iconRenderer';

/**
 * Create an offscreen canvas context for path hit testing.
 * This is cached per-call to avoid creating too many contexts.
 */
let hitTestCanvas: CanvasRenderingContext2D | null = null;

function getHitTestContext(): CanvasRenderingContext2D {
  if (!hitTestCanvas) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    hitTestCanvas = canvas.getContext('2d')!;
  }
  return hitTestCanvas;
}

/**
 * Create a ShapeHandler implementation from a LibraryShapeDefinition.
 *
 * The generated handler provides:
 * - Rendering with fill, stroke, icon, and label support
 * - Path-based or bounds-based hit testing
 * - Bounding box calculation with rotation support
 * - 8 resize handles + 1 rotation handle
 * - Anchor points for connector attachment
 */
export function createLibraryShapeHandler(
  definition: LibraryShapeDefinition
): ShapeHandler<LibraryShape> {
  return {
    /**
     * Render the shape using the definition's path builder.
     */
    render(ctx: CanvasRenderingContext2D, shape: LibraryShape): void {
      const { x, y, width, height, rotation, fill, stroke, strokeWidth, opacity } = shape;

      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.translate(x, y);
      ctx.rotate(rotation);

      // Build the path from the definition
      const path = definition.pathBuilder(width, height);

      // Check if this is icon-only mode (skip fill/stroke)
      const iconOnly = isIconOnlyMode(shape);

      // Fill (skip in icon-only mode)
      if (fill && !iconOnly) {
        ctx.fillStyle = fill;
        ctx.fill(path);
      }

      // Stroke (skip in icon-only mode)
      if (stroke && strokeWidth > 0 && !iconOnly) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth;
        ctx.stroke(path);
      }

      // Call custom render if defined (skip in icon-only mode)
      if (definition.customRender && !iconOnly) {
        definition.customRender(ctx, shape, path);
      }

      // Draw icons using the IconRenderer
      const halfWidth = width / 2;
      const halfHeight = height / 2;

      const hasIcon = shape.iconId || (shape.icons && shape.icons.length > 0);
      if (hasIcon) {
        const defaultColor = stroke || '#333333';
        renderShapeIcons(ctx, shape, { halfWidth, halfHeight }, defaultColor);
      }

      // Draw label if present (unless custom rendering handles it), via the
      // shared label engine.
      if (shape.label && !definition.customLabelRendering) {
        renderLabel(ctx, {
          text: shape.label,
          spec: LIBRARY_LABEL_SPEC,
          overflow: shape.labelOverflow,
          boxWidth: width,
          boxHeight: height,
          fontSize: shape.labelFontSize || DEFAULT_LIBRARY_SHAPE.labelFontSize,
          color: shape.labelColor || stroke || '#000000',
          background: shape.labelBackground,
          offsetX: shape.labelOffsetX || 0,
          offsetY: shape.labelOffsetY || 0,
        });
      }

      ctx.restore();
    },

    /**
     * Test if a world point is inside the shape.
     */
    hitTest(shape: LibraryShape, worldPoint: Vec2): boolean {
      const local = worldToLocal(worldPoint, shape);

      // Use bounds-based hit test if specified
      if (definition.hitTestMode === 'bounds') {
        const halfWidth = shape.width / 2;
        const halfHeight = shape.height / 2;
        const strokePadding = shape.strokeWidth / 2;

        return (
          local.x >= -halfWidth - strokePadding &&
          local.x <= halfWidth + strokePadding &&
          local.y >= -halfHeight - strokePadding &&
          local.y <= halfHeight + strokePadding
        );
      }

      // Path-based hit test (default)
      const path = definition.pathBuilder(shape.width, shape.height);
      const ctx = getHitTestContext();

      // Check if point is inside the path
      // Note: isPointInPath uses the current transform, so we need to reset it
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      // Check fill area
      if (ctx.isPointInPath(path, local.x, local.y)) {
        return true;
      }

      // Also check stroke area for shapes with visible stroke
      if (shape.stroke && shape.strokeWidth > 0) {
        ctx.lineWidth = Math.max(shape.strokeWidth, 5); // Minimum 5px hit area
        if (ctx.isPointInStroke(path, local.x, local.y)) {
          return true;
        }
      }

      return false;
    },

    /**
     * Get the axis-aligned bounding box.
     */
    getBounds(shape: LibraryShape): Box {
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

      const padding = shape.strokeWidth / 2;
      return new Box(minX - padding, minY - padding, maxX + padding, maxY + padding);
    },

    /**
     * Get resize, rotation, and custom handles.
     */
    getHandles(shape: LibraryShape): Handle[] {
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

      const standardHandles: Handle[] = localHandles.map((h) => {
        const world = localToWorld(new Vec2(h.x, h.y), shape);
        return {
          type: h.type,
          x: world.x,
          y: world.y,
          cursor: h.cursor,
          metadata: { isStandard: true },
        };
      });

      // Add custom handles from definition if provided
      if (definition.customHandles) {
        const customHandles = definition.customHandles(shape);
        return [...standardHandles, ...customHandles];
      }

      return standardHandles;
    },

    /**
     * Create a new shape at the given position.
     */
    create(position: Vec2, id: string): LibraryShape {
      return {
        id,
        type: definition.type,
        x: position.x,
        y: position.y,
        width: definition.metadata.defaultWidth,
        height: definition.metadata.defaultHeight,
        rotation: DEFAULT_LIBRARY_SHAPE.rotation,
        opacity: DEFAULT_LIBRARY_SHAPE.opacity,
        locked: DEFAULT_LIBRARY_SHAPE.locked,
        visible: DEFAULT_LIBRARY_SHAPE.visible,
        fill: DEFAULT_LIBRARY_SHAPE.fill,
        stroke: DEFAULT_LIBRARY_SHAPE.stroke,
        strokeWidth: DEFAULT_LIBRARY_SHAPE.strokeWidth,
      };
    },

    /**
     * Get connector anchor points.
     * Uses dynamicAnchors function if provided, otherwise falls back to static anchors array.
     */
    getAnchors(shape: LibraryShape): Anchor[] {
      // Use dynamic anchors if available (for shapes with instance-dependent anchors like ERD entities)
      const anchorDefs = definition.dynamicAnchors
        ? definition.dynamicAnchors(shape, shape.width, shape.height)
        : definition.anchors;

      return anchorDefs.map((anchorDef) => {
        const localX = anchorDef.x(shape.width, shape.height);
        const localY = anchorDef.y(shape.width, shape.height);
        const world = localToWorld(new Vec2(localX, localY), shape);

        return {
          position: anchorDef.position,
          x: world.x,
          y: world.y,
        };
      });
    },

    /**
     * In-place label edit target: centered on the shape. Shapes that render
     * their own text (customLabelRendering) have no standard editable label.
     */
    getLabelEditTarget(shape: LibraryShape) {
      if (definition.customLabelRendering) return null;
      return {
        field: 'label' as const,
        worldRect: { cx: shape.x, cy: shape.y, width: shape.width, height: shape.height },
        fontSize: shape.labelFontSize || DEFAULT_LIBRARY_SHAPE.labelFontSize,
        align: 'center' as const,
        rotation: shape.rotation,
      };
    },
  };
}
