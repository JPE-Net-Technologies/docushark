import { Vec2 } from '../math/Vec2';
import { Box } from '../math/Box';
import { ShapeHandler, shapeRegistry } from './ShapeRegistry';
import { GroupShape, Handle, DEFAULT_GROUP, Shape } from './Shape';
import { useDocumentStore } from '../store/documentStore';
import { createPatternFill, createRoundedRectPath } from '../utils/patternUtils';
import type { GroupLabelPosition } from './GroupStyles';
import { isAutoColor } from '../engine/ContrastResolver';
import { getRenderContext } from '../engine/RenderContext';
import { renderLabel } from './label/renderLabel';
import { GROUP_LABEL_SPEC } from './label/specs';

/**
 * Resolve the AUTO sentinel against the active render frame, sampling at the
 * group's geometric centre. Returns the input unchanged for non-AUTO values
 * or when called outside a render frame.
 */
function resolveGroupAutoColor(
  shape: GroupShape,
  value: string | undefined,
  fallback: string
): string {
  if (!isAutoColor(value)) return value ?? fallback;
  const rc = getRenderContext();
  if (!rc) return fallback;
  // Sample at the group centre so its own bg doesn't influence the lookup.
  const handler = shapeRegistry.getHandler('group');
  const bounds = handler.getBounds(shape);
  const centre = { x: bounds.centerX, y: bounds.centerY };
  return rc.contrastCache.resolve(
    centre,
    rc.shapes,
    rc.shapeOrder,
    rc.pageBackground,
    shape.id
  );
}

/**
 * Get all shapes from the document store.
 * Used to resolve child shapes for bounds and hit testing.
 */
function getShapes(): Record<string, Shape> {
  return useDocumentStore.getState().shapes;
}

/**
 * Recursively get bounds for a shape, handling groups.
 */
function getShapeBounds(shape: Shape): Box {
  const handler = shapeRegistry.getHandler(shape.type);
  return handler.getBounds(shape);
}

/**
 * Calculate label position based on labelPosition anchor and bounds.
 */
function calculateLabelPosition(
  bounds: Box,
  position: GroupLabelPosition,
  padding: number
): { x: number; y: number; textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline } {
  const { minX, minY, maxX, maxY, centerX, centerY } = bounds;

  switch (position) {
    case 'top':
      return { x: centerX, y: minY - padding, textAlign: 'center', textBaseline: 'bottom' };
    case 'top-left':
      return { x: minX, y: minY - padding, textAlign: 'left', textBaseline: 'bottom' };
    case 'top-right':
      return { x: maxX, y: minY - padding, textAlign: 'right', textBaseline: 'bottom' };
    case 'bottom':
      return { x: centerX, y: maxY + padding, textAlign: 'center', textBaseline: 'top' };
    case 'bottom-left':
      return { x: minX, y: maxY + padding, textAlign: 'left', textBaseline: 'top' };
    case 'bottom-right':
      return { x: maxX, y: maxY + padding, textAlign: 'right', textBaseline: 'top' };
    case 'left':
      return { x: minX - padding, y: centerY, textAlign: 'right', textBaseline: 'middle' };
    case 'right':
      return { x: maxX + padding, y: centerY, textAlign: 'left', textBaseline: 'middle' };
    case 'center':
    default:
      return { x: centerX, y: centerY, textAlign: 'center', textBaseline: 'middle' };
  }
}

/**
 * Extended group handler with renderLabel method for two-pass rendering.
 */
export interface GroupShapeHandler extends ShapeHandler<GroupShape> {
  renderLabel(ctx: CanvasRenderingContext2D, shape: GroupShape, parentOpacity?: number): void;
}

/**
 * Group shape handler implementation.
 * Groups are containers that hold other shapes. They can optionally render
 * a visible background, border, and label.
 */
export const groupHandler: GroupShapeHandler = {
  /**
   * Render group background, border, and shadow.
   * Note: Labels are rendered separately via renderLabel() after children.
   */
  render(ctx: CanvasRenderingContext2D, shape: GroupShape): void {
    // Check if group has any visual content to render
    const hasBackground = shape.showBackground;
    const hasBorder = shape.borderWidth && shape.borderWidth > 0;
    const hasShadow = shape.shadowConfig?.enabled;

    if (!hasBackground && !hasBorder && !hasShadow) {
      // No visual representation - remain invisible container
      return;
    }

    // Get group bounds from children
    const bounds = this.getBounds(shape);
    if (bounds.width === 0 && bounds.height === 0) {
      // Empty group, nothing to render
      return;
    }

    // Apply padding to bounds
    const padding = shape.backgroundPadding ?? DEFAULT_GROUP.backgroundPadding;
    const paddedBounds = bounds.expand(padding);

    // Get corner radius
    const cornerRadius = shape.cornerRadius ?? DEFAULT_GROUP.cornerRadius;

    ctx.save();
    ctx.globalAlpha = shape.opacity;

    // Apply shadow if enabled
    if (hasShadow && shape.shadowConfig) {
      ctx.shadowOffsetX = shape.shadowConfig.offsetX;
      ctx.shadowOffsetY = shape.shadowConfig.offsetY;
      ctx.shadowBlur = shape.shadowConfig.blur;
      ctx.shadowColor = shape.shadowConfig.color;
    }

    // Create the background path
    const bgPath = createRoundedRectPath(paddedBounds, cornerRadius);

    // Fill background
    if (hasBackground) {
      if (shape.patternConfig && shape.patternConfig.type !== 'none') {
        // Use pattern/gradient fill
        const fillStyle = createPatternFill(ctx, shape.patternConfig, paddedBounds);
        ctx.fillStyle = fillStyle;
      } else {
        // Use solid background color (resolve AUTO if needed)
        ctx.fillStyle = resolveGroupAutoColor(
          shape,
          shape.backgroundColor,
          DEFAULT_GROUP.backgroundColor
        );
      }
      ctx.fill(bgPath);
    }

    // Clear shadow for border (don't apply shadow to border)
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Draw border
    if (hasBorder) {
      ctx.strokeStyle = resolveGroupAutoColor(shape, shape.borderColor, '#000000');
      ctx.lineWidth = shape.borderWidth!;

      // Apply dash pattern if specified
      if (shape.borderDashArray && shape.borderDashArray.length > 0) {
        ctx.setLineDash(shape.borderDashArray);
      }

      ctx.stroke(bgPath);

      // Reset dash pattern
      ctx.setLineDash([]);
    }

    ctx.restore();
  },

  /**
   * Render group label on top of children.
   * Called by Renderer after rendering children.
   */
  renderLabel(ctx: CanvasRenderingContext2D, shape: GroupShape, parentOpacity: number = 1): void {
    if (!shape.label) return;

    // Get group bounds
    const bounds = this.getBounds(shape);
    if (bounds.width === 0 && bounds.height === 0) return;

    // Apply padding to bounds for label positioning
    const padding = shape.backgroundPadding ?? DEFAULT_GROUP.backgroundPadding;
    const paddedBounds = bounds.expand(padding);

    // Get label properties
    const fontSize = shape.labelFontSize ?? DEFAULT_GROUP.labelFontSize;
    const labelColor = resolveGroupAutoColor(
      shape,
      shape.labelColor,
      DEFAULT_GROUP.labelColor
    );
    const labelBackground = shape.labelBackground;
    const labelPosition = shape.labelPosition ?? DEFAULT_GROUP.labelPosition;
    const labelOffsetX = shape.labelOffsetX ?? 0;
    const labelOffsetY = shape.labelOffsetY ?? 0;

    // Calculate label position
    const pos = calculateLabelPosition(paddedBounds, labelPosition, 4);

    ctx.save();
    ctx.globalAlpha = shape.opacity * parentOpacity;
    // Anchor at the 9-grid point; the shared engine draws the (rounded) pill +
    // text using the position's align/baseline. AUTO color already resolved.
    ctx.translate(pos.x, pos.y);
    renderLabel(ctx, {
      text: shape.label,
      spec: GROUP_LABEL_SPEC,
      overflow: shape.labelOverflow,
      boxWidth: 1000,
      boxHeight: fontSize * 2,
      fontSize,
      color: labelColor,
      background: labelBackground,
      backgroundRound: true,
      backgroundRadius: 4,
      backgroundPadX: 8,
      backgroundPadY: 8,
      anchor: { textAlign: pos.textAlign, textBaseline: pos.textBaseline },
      offsetX: labelOffsetX,
      offsetY: labelOffsetY,
    });
    ctx.restore();
  },

  /**
   * Hit test by checking background area first, then delegating to children.
   * Returns true if the point is in the background area or any child shape is hit.
   */
  hitTest(shape: GroupShape, worldPoint: Vec2): boolean {
    // Check if group has a visible background/border that can be clicked
    const hasClickableArea =
      shape.showBackground || (shape.borderWidth && shape.borderWidth > 0);

    if (hasClickableArea) {
      const bounds = this.getBounds(shape);
      const padding = shape.backgroundPadding ?? DEFAULT_GROUP.backgroundPadding;
      const paddedBounds = bounds.expand(padding);

      if (paddedBounds.containsPoint(worldPoint)) {
        return true;
      }
    }

    // Fall back to child hit testing
    const shapes = getShapes();

    for (const childId of shape.childIds) {
      const child = shapes[childId];
      if (!child || !child.visible) continue;

      const handler = shapeRegistry.getHandler(child.type);
      if (handler.hitTest(child, worldPoint)) {
        return true;
      }
    }

    return false;
  },

  /**
   * Get the combined bounding box of all children.
   */
  getBounds(shape: GroupShape): Box {
    const shapes = getShapes();
    let combined: Box | null = null;

    for (const childId of shape.childIds) {
      const child = shapes[childId];
      if (!child) continue;

      const childBounds = getShapeBounds(child);
      combined = combined ? combined.union(childBounds) : childBounds;
    }

    // If no children or all children removed, return a point at group position
    return combined ?? new Box(shape.x, shape.y, shape.x, shape.y);
  },

  /**
   * Groups don't have handles for now (move-only, no resize/rotation).
   * Returns an empty array.
   */
  getHandles(_shape: GroupShape): Handle[] {
    // No handles for groups - they can only be moved
    return [];
  },

  /**
   * Create a new group shape.
   * Note: childIds should be set after creation when grouping shapes.
   */
  create(position: Vec2, id: string): GroupShape {
    return {
      id,
      type: 'group',
      x: position.x,
      y: position.y,
      rotation: DEFAULT_GROUP.rotation,
      opacity: DEFAULT_GROUP.opacity,
      locked: DEFAULT_GROUP.locked,
      visible: DEFAULT_GROUP.visible,
      fill: DEFAULT_GROUP.fill,
      stroke: DEFAULT_GROUP.stroke,
      strokeWidth: DEFAULT_GROUP.strokeWidth,
      childIds: [],
    };
  },

  /**
   * In-place label edit target: anchored at the group's 9-grid label position,
   * mirroring `renderLabel`'s geometry so the editor sits over the drawn label.
   */
  getLabelEditTarget(shape: GroupShape) {
    const bounds = this.getBounds(shape);
    const padding = shape.backgroundPadding ?? DEFAULT_GROUP.backgroundPadding;
    const paddedBounds = bounds.expand(padding);
    const labelPosition = shape.labelPosition ?? DEFAULT_GROUP.labelPosition;
    const pos = calculateLabelPosition(paddedBounds, labelPosition, 4);
    const fontSize = shape.labelFontSize ?? DEFAULT_GROUP.labelFontSize;
    const align: 'left' | 'center' | 'right' =
      pos.textAlign === 'left' || pos.textAlign === 'right' ? pos.textAlign : 'center';
    return {
      field: 'label' as const,
      worldRect: {
        cx: pos.x + (shape.labelOffsetX ?? 0),
        cy: pos.y + (shape.labelOffsetY ?? 0),
        width: 160,
        height: fontSize * 1.5,
      },
      fontSize,
      align,
      rotation: 0,
    };
  },
};

// Register the group handler
shapeRegistry.register('group', groupHandler);
