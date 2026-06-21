/**
 * Export utilities for PNG and SVG export.
 */

import { Box } from '../math/Box';
import {
  Shape,
  RectangleShape,
  EllipseShape,
  LineShape,
  TextShape,
  ConnectorShape,
  GroupShape,
  DEFAULT_GROUP,
  isRectangle,
  isEllipse,
  isLine,
  isText,
  isConnector,
  isGroup,
} from '../shapes/Shape';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import { normalizeAutoColorsForExport } from '../engine/ContrastResolver';
import { calculateCombinedBounds } from '../shapes/utils/bounds';
import { getConnectorStartPoint, getConnectorEndPoint } from '../shapes/Connector';
import { groupHandler } from '../shapes/Group';
import type { GroupLabelPosition } from '../shapes/GroupStyles';

/**
 * Export options for PNG and SVG export.
 */
export interface ExportOptions {
  /** Export format */
  format: 'png' | 'svg';
  /** Export scope */
  scope: 'all' | 'selection';
  /** Scale factor for PNG (1, 2, 3) */
  scale: number;
  /** Background color or null for transparent */
  background: string | null;
  /** Padding around content in pixels */
  padding: number;
  /** Output filename */
  filename: string;
  /** Flatten groups on export (render children individually, no group container). Default: false */
  flattenGroups?: boolean;
  /** Include whiteboard notes in export. Default: false */
  includeWhiteboard?: boolean;
}

/**
 * Data needed for export operations.
 */
export interface ExportData {
  /** All shapes in the document */
  shapes: Record<string, Shape>;
  /** Shape order (z-order) */
  shapeOrder: string[];
  /** Selected shape IDs (for selection export) */
  selectedIds: string[];
}

/**
 * Get the shapes to export based on scope.
 *
 * For selection export, handles groups intelligently:
 * - If a group is explicitly selected, export the entire group (container + children)
 * - If only some children of a group are selected (partial selection),
 *   export just those children without the group container
 * - This prevents exporting invisible group backgrounds for partial selections
 */
function getShapesToExport(data: ExportData, scope: 'all' | 'selection'): Shape[] {
  if (scope === 'selection' && data.selectedIds.length > 0) {
    const selectedSet = new Set(data.selectedIds);
    const result: Shape[] = [];
    const handled = new Set<string>();

    for (const id of data.selectedIds) {
      if (handled.has(id)) continue;
      const shape = data.shapes[id];
      if (!shape || !shape.visible) continue;

      if (isGroup(shape)) {
        // Group is explicitly selected — include it (render will draw children)
        result.push(shape);
        handled.add(id);
        // Mark children as handled so they aren't double-exported
        for (const childId of shape.childIds) {
          handled.add(childId);
        }
      } else {
        // Check if this shape is a child of a group that is NOT selected
        const parentGroup = findParentGroup(shape, data.shapes);
        if (parentGroup && !selectedSet.has(parentGroup.id)) {
          // Partial selection — export the child individually
          result.push(shape);
        } else {
          // Either top-level shape or parent group is also selected
          // If parent group is selected, it's already handled above
          if (!parentGroup || !selectedSet.has(parentGroup.id)) {
            result.push(shape);
          }
        }
        handled.add(id);
      }
    }

    return result;
  }

  // All shapes in z-order
  return data.shapeOrder
    .map((id) => data.shapes[id])
    .filter((s): s is Shape => s !== undefined && s.visible);
}

/**
 * Find the parent group of a shape, if any.
 */
function findParentGroup(
  shape: Shape,
  allShapes: Record<string, Shape>
): GroupShape | null {
  for (const candidate of Object.values(allShapes)) {
    if (candidate && isGroup(candidate)) {
      if (candidate.childIds.includes(shape.id)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Estimate label bounds expansion based on label position.
 * Returns the additional padding needed on each side [top, right, bottom, left].
 */
function estimateLabelExpansion(
  labelPosition: GroupLabelPosition,
  fontSize: number
): [number, number, number, number] {
  // Estimate label height (fontSize + some padding for text metrics)
  const labelHeight = fontSize * 1.5;
  // Estimate approximate label width (varies by text, use generous estimate)
  const labelWidth = 200;

  switch (labelPosition) {
    case 'top':
    case 'top-left':
    case 'top-right':
      return [labelHeight + 8, 0, 0, 0]; // Top expansion
    case 'bottom':
    case 'bottom-left':
    case 'bottom-right':
      return [0, 0, labelHeight + 8, 0]; // Bottom expansion
    case 'left':
      return [0, 0, 0, labelWidth]; // Left expansion
    case 'right':
      return [0, labelWidth, 0, 0]; // Right expansion
    case 'center':
    default:
      return [0, 0, 0, 0]; // No expansion needed
  }
}

/**
 * Calculate the bounds for export.
 */
export function getExportBounds(data: ExportData, scope: 'all' | 'selection'): Box | null {
  const shapes = getShapesToExport(data, scope);
  if (shapes.length === 0) return null;

  // For groups, we need to include children in bounds calculation
  const allShapes: Shape[] = [];
  // Track groups with labels for bounds expansion
  const groupsWithLabels: GroupShape[] = [];

  const addShapeAndChildren = (shape: Shape) => {
    if (isGroup(shape)) {
      // Track groups that have labels for bounds expansion
      if (shape.label) {
        groupsWithLabels.push(shape);
      }
      for (const childId of shape.childIds) {
        const child = data.shapes[childId];
        if (child && child.visible) {
          addShapeAndChildren(child);
        }
      }
    } else {
      allShapes.push(shape);
    }
  };

  for (const shape of shapes) {
    addShapeAndChildren(shape);
  }

  let bounds = calculateCombinedBounds(allShapes);
  if (!bounds) return null;

  // Expand bounds to include group labels and backgrounds
  for (const group of groupsWithLabels) {
    // Get group background padding
    const bgPadding = group.backgroundPadding ?? DEFAULT_GROUP.backgroundPadding;
    // Expand for background first
    bounds = bounds.expand(bgPadding);

    // Get label position and font size
    const labelPosition = group.labelPosition ?? DEFAULT_GROUP.labelPosition;
    const fontSize = group.labelFontSize ?? DEFAULT_GROUP.labelFontSize;

    // Calculate label expansion
    const [top, right, bottom, left] = estimateLabelExpansion(labelPosition, fontSize);

    // Expand bounds for label
    if (top > 0 || right > 0 || bottom > 0 || left > 0) {
      bounds = new Box(
        bounds.minX - left,
        bounds.minY - top,
        bounds.maxX + right,
        bounds.maxY + bottom
      );
    }
  }

  return bounds;
}

// ============ PNG Export ============

/**
 * Clean up canvas resources to free memory.
 * This is especially important for large exports.
 */
function cleanupCanvas(canvas: HTMLCanvasElement): void {
  // Clear canvas content
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Set dimensions to 0 to release memory
  canvas.width = 0;
  canvas.height = 0;

  // Remove from DOM if attached (shouldn't be, but defensive)
  if (canvas.parentNode) {
    canvas.parentNode.removeChild(canvas);
  }
}

/**
 * Export shapes to PNG.
 */
export async function exportToPng(
  data: ExportData,
  options: ExportOptions
): Promise<Blob> {
  const bounds = getExportBounds(data, options.scope);
  if (!bounds) {
    throw new Error('No shapes to export');
  }

  const { scale, padding, background } = options;

  // Calculate canvas size
  const width = Math.ceil((bounds.width + padding * 2) * scale);
  const height = Math.ceil((bounds.height + padding * 2) * scale);

  // Create offscreen canvas
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    cleanupCanvas(canvas);
    throw new Error('Could not get canvas context');
  }

  try {
    // Apply scale
    ctx.scale(scale, scale);

    // Fill background
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width / scale, height / scale);
    }

    // Translate to account for bounds offset and padding
    ctx.translate(padding - bounds.minX, padding - bounds.minY);

    // Get shapes to render
    const shapes = getShapesToExport(data, options.scope);

    // Render shapes in z-order
    for (const shape of shapes) {
      renderShapeForExport(ctx, shape, data.shapes, 1, options.flattenGroups);
    }

    // Convert to blob and cleanup
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          // Clean up canvas resources after blob is created
          cleanupCanvas(canvas);

          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to create PNG blob'));
          }
        },
        'image/png',
        1.0
      );
    });
  } catch (error) {
    // Ensure cleanup on any error during rendering
    cleanupCanvas(canvas);
    throw error;
  }
}

/**
 * Render a shape for export (handles groups recursively).
 */
function renderShapeForExport(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  allShapes: Record<string, Shape>,
  parentOpacity: number,
  flattenGroups?: boolean
): void {
  if (!shape.visible) return;

  const effectiveOpacity = shape.opacity * parentOpacity;

  if (isGroup(shape)) {
    if (!flattenGroups) {
      // 1. Render group background/border first
      ctx.save();
      ctx.globalAlpha = effectiveOpacity;
      groupHandler.render(ctx, shape);
      ctx.restore();
    }

    // 2. Render children with inherited opacity
    for (const childId of shape.childIds) {
      const child = allShapes[childId];
      if (child) {
        renderShapeForExport(ctx, child, allShapes, effectiveOpacity, flattenGroups);
      }
    }

    if (!flattenGroups) {
      // 3. Render group label on top
      ctx.save();
      groupHandler.renderLabel(ctx, shape, effectiveOpacity);
      ctx.restore();
    }
  } else {
    ctx.save();
    ctx.globalAlpha = effectiveOpacity;
    const handler = shapeRegistry.getHandler(shape.type);
    if (handler) {
      handler.render(ctx, shape);
    } else {
      // Fallback for unknown shape types: render placeholder box
      renderUnknownShapeFallback(ctx, shape);
    }
    ctx.restore();
  }
}

/**
 * Render a placeholder for unknown shape types.
 */
function renderUnknownShapeFallback(ctx: CanvasRenderingContext2D, shape: Shape): void {
  // Get bounds if available, otherwise use x,y with default size
  const handler = shapeRegistry.getHandler(shape.type);
  let bounds: Box;
  if (handler) {
    bounds = handler.getBounds(shape);
  } else {
    // Estimate bounds from shape properties
    const width = 'width' in shape ? (shape as { width: number }).width : 100;
    const height = 'height' in shape ? (shape as { height: number }).height : 60;
    bounds = new Box(shape.x - width / 2, shape.y - height / 2, shape.x + width / 2, shape.y + height / 2);
  }

  // Draw dashed rectangle
  ctx.strokeStyle = '#999999';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(bounds.minX, bounds.minY, bounds.width, bounds.height);
  ctx.setLineDash([]);

  // Draw type label
  ctx.fillStyle = '#666666';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`[${shape.type}]`, bounds.centerX, bounds.centerY);

  console.warn(`[Export] Unknown shape type "${shape.type}" rendered as placeholder`);
}

// ============ SVG Export ============

/**
 * Choose a concrete ink for AUTO ("Automatic") colours given the export
 * background: dark ink on a light surface, light ink on a dark one. A
 * transparent (null) background is assumed to sit on a light surface.
 */
export function inkForBackground(background: string | null): string {
  if (!background) return '#000000';
  const hex = background.trim().replace(/^#/, '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  if (full.length < 6) return '#000000'; // non-hex (named colour / rgba) → assume light
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  // Perceived luminance (sRGB-weighted), 0..1.
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5 ? '#ffffff' : '#000000';
}

/**
 * Export shapes to SVG string.
 */
export function exportToSvg(data: ExportData, options: ExportOptions): string {
  const bounds = getExportBounds(data, options.scope);
  if (!bounds) {
    throw new Error('No shapes to export');
  }

  const { padding, background } = options;

  // Calculate SVG dimensions
  const width = bounds.width + padding * 2;
  const height = bounds.height + padding * 2;

  // Offset to translate shapes
  const offsetX = padding - bounds.minX;
  const offsetY = padding - bounds.minY;

  // Resolve AUTO colour sentinels to concrete colours before emitting. Without
  // this, connectors/lines carrying the default `stroke: 'auto'` emit
  // `stroke="auto"`, which SVG treats as the initial value `none` → the line
  // isn't drawn, while the arrowhead's `fill="auto"` falls back to black, so
  // only the tip renders. The ink adapts to the chosen surface (dark on a light
  // background, light on a dark one) so AUTO shapes stay visible either way.
  const resolvedData: ExportData = {
    ...data,
    shapes: normalizeAutoColorsForExport(data.shapes, inkForBackground(background)),
  };

  // Get shapes to export
  const shapes = getShapesToExport(resolvedData, options.scope);

  // Build SVG elements
  const elements: string[] = [];

  // Background rect
  if (background) {
    elements.push(`  <rect x="0" y="0" width="${width}" height="${height}" fill="${background}"/>`);
  }

  // Render shapes
  for (const shape of shapes) {
    const svg = shapeToSvg(shape, resolvedData.shapes, offsetX, offsetY, 1, options.flattenGroups);
    if (svg) {
      elements.push(svg);
    }
  }

  // Build final SVG
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${elements.join('\n')}
</svg>`;
}

/**
 * Convert a shape to SVG element string.
 */
function shapeToSvg(
  shape: Shape,
  allShapes: Record<string, Shape>,
  offsetX: number,
  offsetY: number,
  parentOpacity: number,
  flattenGroups?: boolean
): string {
  if (!shape.visible) return '';

  const effectiveOpacity = shape.opacity * parentOpacity;

  if (isGroup(shape)) {
    return groupToSvg(shape, allShapes, offsetX, offsetY, effectiveOpacity, flattenGroups);
  } else if (isRectangle(shape)) {
    return rectangleToSvg(shape, offsetX, offsetY, effectiveOpacity);
  } else if (isEllipse(shape)) {
    return ellipseToSvg(shape, offsetX, offsetY, effectiveOpacity);
  } else if (isLine(shape)) {
    return lineToSvg(shape, offsetX, offsetY, effectiveOpacity);
  } else if (isText(shape)) {
    return textToSvg(shape, offsetX, offsetY, effectiveOpacity);
  } else if (isConnector(shape)) {
    return connectorToSvg(shape, allShapes, offsetX, offsetY, effectiveOpacity);
  }

  // Fallback for unknown shape types
  return unknownShapeToSvg(shape, offsetX, offsetY, effectiveOpacity);
}

/**
 * Convert a group to SVG.
 */
function groupToSvg(
  group: GroupShape,
  allShapes: Record<string, Shape>,
  offsetX: number,
  offsetY: number,
  opacity: number,
  flattenGroups?: boolean
): string {
  const children: string[] = [];

  for (const childId of group.childIds) {
    const child = allShapes[childId];
    if (child) {
      const svg = shapeToSvg(child, allShapes, offsetX, offsetY, opacity, flattenGroups);
      if (svg) {
        children.push(svg);
      }
    }
  }

  if (children.length === 0) return '';

  if (flattenGroups) {
    // No group wrapper — just render children directly
    return children.join('\n');
  }

  return `  <g>
${children.join('\n')}
  </g>`;
}

/**
 * Convert a rectangle to SVG.
 */
function rectangleToSvg(
  shape: RectangleShape,
  offsetX: number,
  offsetY: number,
  opacity: number
): string {
  const x = shape.x + offsetX - shape.width / 2;
  const y = shape.y + offsetY - shape.height / 2;
  const cx = shape.x + offsetX;
  const cy = shape.y + offsetY;
  const rotation = (shape.rotation * 180) / Math.PI;

  const attrs: string[] = [
    `x="${x}"`,
    `y="${y}"`,
    `width="${shape.width}"`,
    `height="${shape.height}"`,
  ];

  if (shape.cornerRadius > 0) {
    attrs.push(`rx="${shape.cornerRadius}"`);
    attrs.push(`ry="${shape.cornerRadius}"`);
  }

  attrs.push(...getStyleAttrs(shape, opacity));

  if (rotation !== 0) {
    attrs.push(`transform="rotate(${rotation}, ${cx}, ${cy})"`);
  }

  let svg = `  <rect ${attrs.join(' ')}/>`;

  // Add label if present
  if (shape.label) {
    const labelSvg = labelToSvg(
      shape.label,
      cx,
      cy,
      shape.labelFontSize || 14,
      shape.labelColor || shape.stroke || '#000000',
      rotation,
      opacity
    );
    svg += '\n' + labelSvg;
  }

  return svg;
}

/**
 * Convert an ellipse to SVG.
 */
function ellipseToSvg(
  shape: EllipseShape,
  offsetX: number,
  offsetY: number,
  opacity: number
): string {
  const cx = shape.x + offsetX;
  const cy = shape.y + offsetY;
  const rotation = (shape.rotation * 180) / Math.PI;

  const attrs: string[] = [
    `cx="${cx}"`,
    `cy="${cy}"`,
    `rx="${shape.radiusX}"`,
    `ry="${shape.radiusY}"`,
  ];

  attrs.push(...getStyleAttrs(shape, opacity));

  if (rotation !== 0) {
    attrs.push(`transform="rotate(${rotation}, ${cx}, ${cy})"`);
  }

  let svg = `  <ellipse ${attrs.join(' ')}/>`;

  // Add label if present
  if (shape.label) {
    const labelSvg = labelToSvg(
      shape.label,
      cx,
      cy,
      shape.labelFontSize || 14,
      shape.labelColor || shape.stroke || '#000000',
      rotation,
      opacity
    );
    svg += '\n' + labelSvg;
  }

  return svg;
}

/**
 * Convert a line to SVG.
 */
function lineToSvg(
  shape: LineShape,
  offsetX: number,
  offsetY: number,
  opacity: number
): string {
  const x1 = shape.x + offsetX;
  const y1 = shape.y + offsetY;
  const x2 = shape.x2 + offsetX;
  const y2 = shape.y2 + offsetY;

  const elements: string[] = [];

  // Line element
  const lineAttrs: string[] = [
    `x1="${x1}"`,
    `y1="${y1}"`,
    `x2="${x2}"`,
    `y2="${y2}"`,
    ...getStrokeAttrs(shape, opacity),
  ];

  elements.push(`  <line ${lineAttrs.join(' ')}/>`);

  // Start arrow
  if (shape.startArrow) {
    const arrowSvg = arrowToSvg(x1, y1, x2, y2, shape.strokeWidth, shape.stroke || '#000000', opacity, true);
    elements.push(arrowSvg);
  }

  // End arrow
  if (shape.endArrow) {
    const arrowSvg = arrowToSvg(x1, y1, x2, y2, shape.strokeWidth, shape.stroke || '#000000', opacity, false);
    elements.push(arrowSvg);
  }

  return elements.join('\n');
}

/**
 * Point at fraction `t` (0..1) along a polyline, measured by arc length, so a
 * connector label lands on the routed path rather than the straight midpoint.
 */
function pointAlongPolyline(points: Array<{ x: number; y: number }>, t: number): { x: number; y: number } {
  if (points.length === 1) return points[0]!;
  const segLens: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    segLens.push(len);
    total += len;
  }
  if (total === 0) return points[0]!;
  let target = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < segLens.length; i++) {
    const len = segLens[i]!;
    if (target <= len || i === segLens.length - 1) {
      const f = len === 0 ? 0 : target / len;
      const a = points[i]!;
      const b = points[i + 1]!;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    target -= len;
  }
  return points[points.length - 1]!;
}

/**
 * Convert a connector to SVG.
 */
function connectorToSvg(
  shape: ConnectorShape,
  allShapes: Record<string, Shape>,
  offsetX: number,
  offsetY: number,
  opacity: number
): string {
  const startPoint = getConnectorStartPoint(shape, allShapes);
  const endPoint = getConnectorEndPoint(shape, allShapes);

  // Full routed path: start → waypoints (for non-straight modes) → end, in the
  // same order the canvas renders. Honoring waypoints keeps orthogonal routing
  // instead of collapsing every connector to a straight start→end line.
  const path: Array<{ x: number; y: number }> = [{ x: startPoint.x + offsetX, y: startPoint.y + offsetY }];
  if (shape.routingMode !== 'straight' && shape.waypoints && shape.waypoints.length > 0) {
    for (const wp of shape.waypoints) path.push({ x: wp.x + offsetX, y: wp.y + offsetY });
  }
  path.push({ x: endPoint.x + offsetX, y: endPoint.y + offsetY });

  const elements: string[] = [];
  const strokeAttrs = getStrokeAttrs(shape, opacity).join(' ');

  if (path.length === 2) {
    const a = path[0]!;
    const b = path[1]!;
    elements.push(`  <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ${strokeAttrs}/>`);
  } else {
    const pts = path.map((p) => `${p.x},${p.y}`).join(' ');
    elements.push(`  <polyline points="${pts}" fill="none" ${strokeAttrs}/>`);
  }

  // Arrowheads point along the adjacent path segment (not start→end), so they
  // sit correctly on a bent route. arrowToSvg places the tip at (x2,y2).
  const arrowColor = shape.stroke || '#000000';
  if (shape.startArrow) {
    const a = path[1]!;
    const tip = path[0]!;
    elements.push(arrowToSvg(a.x, a.y, tip.x, tip.y, shape.strokeWidth, arrowColor, opacity, false));
  }
  if (shape.endArrow) {
    const a = path[path.length - 2]!;
    const tip = path[path.length - 1]!;
    elements.push(arrowToSvg(a.x, a.y, tip.x, tip.y, shape.strokeWidth, arrowColor, opacity, false));
  }

  // Label at `labelPosition` along the routed polyline (+ offset). An optional
  // halo (`labelStrokeColor`) keeps it legible where it crosses a shape.
  if (shape.label) {
    const at = pointAlongPolyline(path, shape.labelPosition ?? 0.5);
    const lx = at.x + (shape.labelOffsetX ?? 0);
    const ly = at.y + (shape.labelOffsetY ?? 0);
    const labelColor = shape.labelColor || shape.stroke || '#000000';
    elements.push(
      labelToSvg(shape.label, lx, ly, shape.labelFontSize || 12, labelColor, 0, opacity, shape.labelStrokeColor)
    );
  }

  return elements.join('\n');
}

/**
 * Convert text to SVG.
 */
function textToSvg(
  shape: TextShape,
  offsetX: number,
  offsetY: number,
  opacity: number
): string {
  const cx = shape.x + offsetX;
  const cy = shape.y + offsetY;
  const rotation = (shape.rotation * 180) / Math.PI;

  // Calculate text anchor
  let textAnchor = 'middle';
  if (shape.textAlign === 'left') textAnchor = 'start';
  else if (shape.textAlign === 'right') textAnchor = 'end';

  // Calculate dominant baseline
  let dominantBaseline = 'central';
  if (shape.verticalAlign === 'top') dominantBaseline = 'hanging';
  else if (shape.verticalAlign === 'bottom') dominantBaseline = 'auto';

  // Calculate text position based on alignment
  let textX = cx;
  if (shape.textAlign === 'left') textX = cx - shape.width / 2;
  else if (shape.textAlign === 'right') textX = cx + shape.width / 2;

  let textY = cy;
  if (shape.verticalAlign === 'top') textY = cy - shape.height / 2;
  else if (shape.verticalAlign === 'bottom') textY = cy + shape.height / 2;

  // Split text into lines
  const lines = shape.text.split('\n');
  const lineHeight = shape.fontSize * 1.2;

  // Calculate starting Y position
  let startY = textY;
  if (shape.verticalAlign === 'middle') {
    startY = textY - ((lines.length - 1) * lineHeight) / 2;
  } else if (shape.verticalAlign === 'bottom') {
    startY = textY - (lines.length - 1) * lineHeight;
  }

  const attrs: string[] = [
    `x="${textX}"`,
    `y="${startY}"`,
    `font-family="${shape.fontFamily}"`,
    `font-size="${shape.fontSize}"`,
    `text-anchor="${textAnchor}"`,
    `dominant-baseline="${dominantBaseline}"`,
    `fill="${shape.fill || '#000000'}"`,
  ];

  if (opacity < 1) {
    attrs.push(`opacity="${opacity}"`);
  }

  if (rotation !== 0) {
    attrs.push(`transform="rotate(${rotation}, ${cx}, ${cy})"`);
  }

  if (lines.length === 1) {
    return `  <text ${attrs.join(' ')}>${escapeXml(shape.text)}</text>`;
  }

  // Multi-line text with tspans
  const tspans = lines.map((line, i) => {
    const dy = i === 0 ? 0 : lineHeight;
    return `    <tspan x="${textX}" dy="${dy}">${escapeXml(line)}</tspan>`;
  });

  return `  <text ${attrs.join(' ')}>
${tspans.join('\n')}
  </text>`;
}

/**
 * Convert a label to SVG text element.
 */
function labelToSvg(
  text: string,
  cx: number,
  cy: number,
  fontSize: number,
  color: string,
  rotation: number,
  opacity: number,
  haloColor?: string
): string {
  // Split on explicit newlines (e.g. Mermaid `\n` / `<br/>` node labels). The
  // single shared label helper is used by rectangle / ellipse / connector, so
  // this also fixes multi-line node labels overflowing as one line.
  const lines = text.split('\n');
  const lineHeight = fontSize * 1.2;
  // Vertically centre the block on (cx, cy): lift the first baseline by half
  // the total line span, then step each subsequent line down by one line.
  const startY = cy - ((lines.length - 1) * lineHeight) / 2;

  const attrs: string[] = [
    `x="${cx}"`,
    `y="${startY}"`,
    `font-family="sans-serif"`,
    `font-size="${fontSize}"`,
    `text-anchor="middle"`,
    `dominant-baseline="central"`,
    `fill="${color}"`,
  ];

  // Optional legibility halo: paint a stroke under the fill so the label stays
  // readable where it crosses a filled shape.
  if (haloColor) {
    attrs.push(`stroke="${haloColor}"`, `stroke-width="3"`, `stroke-linejoin="round"`, `paint-order="stroke"`);
  }

  if (opacity < 1) {
    attrs.push(`opacity="${opacity}"`);
  }

  if (rotation !== 0) {
    attrs.push(`transform="rotate(${rotation}, ${cx}, ${cy})"`);
  }

  if (lines.length === 1) {
    return `  <text ${attrs.join(' ')}>${escapeXml(text)}</text>`;
  }

  const tspans = lines.map((line, i) => {
    const dy = i === 0 ? 0 : lineHeight;
    return `    <tspan x="${cx}" dy="${dy}">${escapeXml(line)}</tspan>`;
  });

  return `  <text ${attrs.join(' ')}>
${tspans.join('\n')}
  </text>`;
}

/**
 * Convert an arrow head to SVG polygon.
 */
function arrowToSvg(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  strokeWidth: number,
  color: string,
  opacity: number,
  isStart: boolean
): string {
  const size = strokeWidth * 4;
  const angle = Math.atan2(y2 - y1, x2 - x1);

  // Arrow tip position
  let tipX: number, tipY: number;
  let arrowAngle: number;

  if (isStart) {
    tipX = x1;
    tipY = y1;
    arrowAngle = angle + Math.PI; // Point away from line
  } else {
    tipX = x2;
    tipY = y2;
    arrowAngle = angle;
  }

  // Calculate arrow points (triangle)
  const backLength = size;
  const wingLength = size * 0.5;

  // Back center point
  const backX = tipX - Math.cos(arrowAngle) * backLength;
  const backY = tipY - Math.sin(arrowAngle) * backLength;

  // Wing points
  const wing1X = backX + Math.cos(arrowAngle + Math.PI / 2) * wingLength;
  const wing1Y = backY + Math.sin(arrowAngle + Math.PI / 2) * wingLength;
  const wing2X = backX + Math.cos(arrowAngle - Math.PI / 2) * wingLength;
  const wing2Y = backY + Math.sin(arrowAngle - Math.PI / 2) * wingLength;

  const points = `${tipX},${tipY} ${wing1X},${wing1Y} ${wing2X},${wing2Y}`;

  const attrs = [`points="${points}"`, `fill="${color}"`];

  if (opacity < 1) {
    attrs.push(`opacity="${opacity}"`);
  }

  return `  <polygon ${attrs.join(' ')}/>`;
}

/**
 * Get common style attributes for a shape.
 */
function getStyleAttrs(shape: Shape, opacity: number): string[] {
  const attrs: string[] = [];

  attrs.push(`fill="${shape.fill || 'none'}"`);
  attrs.push(`stroke="${shape.stroke || 'none'}"`);

  if (shape.strokeWidth > 0) {
    attrs.push(`stroke-width="${shape.strokeWidth}"`);
  }

  if (opacity < 1) {
    attrs.push(`opacity="${opacity}"`);
  }

  return attrs;
}

/**
 * Get stroke-only attributes for lines.
 */
function getStrokeAttrs(shape: Shape, opacity: number): string[] {
  const attrs: string[] = [];

  attrs.push(`stroke="${shape.stroke || '#000000'}"`);

  if (shape.strokeWidth > 0) {
    attrs.push(`stroke-width="${shape.strokeWidth}"`);
  }

  if (opacity < 1) {
    attrs.push(`opacity="${opacity}"`);
  }

  return attrs;
}

/**
 * Escape special XML characters.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Convert unknown shape type to SVG placeholder.
 */
function unknownShapeToSvg(
  shape: Shape,
  offsetX: number,
  offsetY: number,
  opacity: number
): string {
  // Estimate bounds from shape properties
  const width = 'width' in shape ? (shape as { width: number }).width : 100;
  const height = 'height' in shape ? (shape as { height: number }).height : 60;
  const x = shape.x + offsetX - width / 2;
  const y = shape.y + offsetY - height / 2;
  const cx = shape.x + offsetX;
  const cy = shape.y + offsetY;

  console.warn(`[Export] Unknown shape type "${shape.type}" exported as placeholder`);

  const elements = [
    // Dashed rectangle
    `  <rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="#999999" stroke-width="1" stroke-dasharray="4,4"${opacity < 1 ? ` opacity="${opacity}"` : ''}/>`,
    // Type label
    `  <text x="${cx}" y="${cy}" font-family="sans-serif" font-size="12" text-anchor="middle" dominant-baseline="central" fill="#666666"${opacity < 1 ? ` opacity="${opacity}"` : ''}>[${escapeXml(shape.type)}]</text>`,
  ];

  return elements.join('\n');
}
