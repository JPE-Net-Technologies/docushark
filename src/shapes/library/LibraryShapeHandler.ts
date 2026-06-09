/**
 * Factory for creating ShapeHandler implementations from a ShapeDefinition.
 *
 * Declarative definitions are converted into fully functional handlers
 * (render, hit test, bounds, handles, anchors, label editing). The factory
 * defaults to centered-box geometry and lets a definition override any aspect
 * (size accessor, hit test, bounds, handles, create) — so it can express both
 * library shapes and the core box primitives (rectangle, ellipse).
 */

import { Vec2 } from '../../math/Vec2';
import { Box } from '../../math/Box';
import type { ShapeHandler } from '../ShapeRegistry';
import type {
  Shape,
  BaseShape,
  LibraryShape,
  Handle,
  HandleType,
  Anchor,
  IconConfig,
} from '../Shape';
import { DEFAULT_LIBRARY_SHAPE } from '../Shape';
import type { ShapeDefinition, LibraryShapeDefinition } from './ShapeLibraryTypes';
import { localToWorld, worldToLocal, getWorldCorners } from '../utils/localSpace';
import { renderLabel } from '../label/renderLabel';
import { LIBRARY_LABEL_SPEC } from '../label/specs';
import type { LabelSpec, LabelOverflow } from '../label/LabelSpec';
import { renderShapeIcons, isIconOnlyMode, iconOnlyLabelOffsetY, iconOnlyRenderSize } from '../../utils/iconRenderer';

/**
 * Structural view of the label + icon fields the factory reads. Core shapes
 * (rectangle, ellipse) and library shapes all carry these as optional fields.
 */
type FactoryShape = BaseShape & {
  label?: string;
  labelFontSize?: number;
  labelColor?: string;
  labelBackground?: string;
  labelOffsetX?: number;
  labelOffsetY?: number;
  labelOverflow?: LabelOverflow;
  iconId?: string;
  icons?: IconConfig[];
};

/**
 * Create an offscreen canvas context for path hit testing, cached to avoid
 * creating too many contexts.
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
 * Create a ShapeHandler from a ShapeDefinition.
 *
 * The generated handler provides rendering (fill/stroke/icon/label),
 * hit testing (box, path, or custom), bounds, handles, anchors, and in-place
 * label editing — defaulting to centered-box geometry and honoring any
 * geometry overrides the definition supplies.
 */
export function createShapeHandler<T extends Shape>(
  definition: ShapeDefinition<T>
): ShapeHandler<T> {
  const labelSpec: LabelSpec = definition.labelSpec ?? LIBRARY_LABEL_SPEC;

  /** Resolve a shape's bounding-box size (defaults to width/height fields). */
  const sizeOf = (shape: T): { width: number; height: number } => {
    if (definition.getSize) return definition.getSize(shape);
    const s = shape as { width?: number; height?: number };
    return { width: s.width ?? 0, height: s.height ?? 0 };
  };

  return {
    render(ctx: CanvasRenderingContext2D, shape: T): void {
      const { width, height } = sizeOf(shape);
      const { x, y, rotation, fill, stroke, strokeWidth, opacity } = shape;
      const f = shape as FactoryShape;

      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.translate(x, y);
      ctx.rotate(rotation);

      const path = definition.pathBuilder(width, height, shape);
      const iconOnly = isIconOnlyMode(f);

      if (fill && !iconOnly) {
        ctx.fillStyle = fill;
        ctx.fill(path);
      }
      if (stroke && strokeWidth > 0 && !iconOnly) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth;
        ctx.stroke(path);
      }
      if (definition.customRender && !iconOnly) {
        definition.customRender(ctx, shape, path);
      }

      const halfWidth = width / 2;
      const halfHeight = height / 2;
      const hasIcon = f.iconId || (f.icons && f.icons.length > 0);
      if (hasIcon) {
        const defaultColor = stroke || '#333333';
        renderShapeIcons(ctx, f, { halfWidth, halfHeight }, defaultColor);
      }

      if (f.label && !definition.customLabelRendering) {
        const labelFontSize = f.labelFontSize || DEFAULT_LIBRARY_SHAPE.labelFontSize;
        // In icon-only mode the icon occupies an `iconSize`-square centred on the
        // shape, so a centred label would render straight through it. Default the
        // label to sit just below the icon — offset sticks to the icon's size, so
        // it tracks larger/smaller icons. A user-set `labelOffsetY` still wins
        // (use `??` so an explicit 0 pulls the label back to centre).
        const defaultOffsetY = iconOnly
          ? iconOnlyLabelOffsetY(iconOnlyRenderSize(width, height), labelFontSize)
          : 0;
        renderLabel(ctx, {
          text: f.label,
          spec: labelSpec,
          overflow: f.labelOverflow,
          boxWidth: width,
          boxHeight: height,
          fontSize: labelFontSize,
          color: f.labelColor || stroke || '#000000',
          background: f.labelBackground,
          offsetX: f.labelOffsetX || 0,
          offsetY: f.labelOffsetY ?? defaultOffsetY,
        });
      }

      ctx.restore();
    },

    hitTest(shape: T, worldPoint: Vec2): boolean {
      if (definition.customHitTest) return definition.customHitTest(shape, worldPoint);

      const local = worldToLocal(worldPoint, shape);
      const { width, height } = sizeOf(shape);

      if (definition.hitTestMode === 'bounds') {
        const hw = width / 2;
        const hh = height / 2;
        const sp = shape.strokeWidth / 2;
        return local.x >= -hw - sp && local.x <= hw + sp && local.y >= -hh - sp && local.y <= hh + sp;
      }

      const path = definition.pathBuilder(width, height, shape);
      const ctx = getHitTestContext();
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      if (ctx.isPointInPath(path, local.x, local.y)) return true;
      if (shape.stroke && shape.strokeWidth > 0) {
        ctx.lineWidth = Math.max(shape.strokeWidth, 5);
        if (ctx.isPointInStroke(path, local.x, local.y)) return true;
      }
      return false;
    },

    getBounds(shape: T): Box {
      if (definition.customBounds) return definition.customBounds(shape);

      const { width, height } = sizeOf(shape);
      const corners = getWorldCorners(shape, width, height);

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

    getHandles(shape: T): Handle[] {
      if (definition.handles) return definition.handles(shape);

      const { width, height } = sizeOf(shape);
      const halfWidth = width / 2;
      const halfHeight = height / 2;
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
        return { type: h.type, x: world.x, y: world.y, cursor: h.cursor, metadata: { isStandard: true } };
      });

      if (definition.customHandles) {
        return [...standardHandles, ...definition.customHandles(shape)];
      }
      return standardHandles;
    },

    create(position: Vec2, id: string): T {
      if (definition.create) return definition.create(position, id);
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
      } as unknown as T;
    },

    getAnchors(shape: T): Anchor[] {
      const { width, height } = sizeOf(shape);
      const anchorDefs = definition.dynamicAnchors
        ? definition.dynamicAnchors(shape, width, height)
        : definition.anchors;

      return anchorDefs.map((anchorDef) => {
        const localX = anchorDef.x(width, height);
        const localY = anchorDef.y(width, height);
        const world = localToWorld(new Vec2(localX, localY), shape);
        return { position: anchorDef.position, x: world.x, y: world.y };
      });
    },

    getLabelEditTarget(shape: T) {
      if (definition.customLabelRendering) return null;
      const { width, height } = sizeOf(shape);
      const f = shape as FactoryShape;
      return {
        field: 'label' as const,
        worldRect: { cx: shape.x, cy: shape.y, width, height },
        fontSize: f.labelFontSize || DEFAULT_LIBRARY_SHAPE.labelFontSize,
        align: 'center' as const,
        rotation: shape.rotation,
      };
    },
  };
}

/**
 * Library-shape specialization. The ~40 built-in library shapes register
 * through this entry point.
 */
export function createLibraryShapeHandler(
  definition: LibraryShapeDefinition
): ShapeHandler<LibraryShape> {
  return createShapeHandler(definition);
}
