import { Vec2 } from '../math/Vec2';
import { Box } from '../math/Box';
import { ShapeHandler, shapeRegistry } from './ShapeRegistry';
import {
  ConnectorShape,
  Handle,
  Anchor,
  Shape,
  DEFAULT_CONNECTOR,
  ERDCardinality,
  UMLClassMarker,
  UMLSequenceMarker,
  ArrowStyle,
  resolveArrowStyle,
} from './Shape';
import { isAutoColor } from '../engine/ContrastResolver';
import { getRenderContext } from '../engine/RenderContext';
import { renderLabel } from './label/renderLabel';
import { CONNECTOR_LABEL_SPEC, CONNECTOR_LABEL_MAX_WIDTH } from './label/specs';
import type { LabelOverflow } from './label/LabelSpec';

/**
 * Resolve a stroke colour at the midpoint of a single line segment, sampling
 * the topmost shape underneath. Returns the input unchanged if it is not the
 * AUTO sentinel, or if no render context is active.
 */
function resolveSegmentStroke(
  rawStroke: string,
  from: Vec2,
  to: Vec2,
  connectorId: string
): string {
  if (!isAutoColor(rawStroke)) return rawStroke;
  const rc = getRenderContext();
  if (!rc) return '#000000'; // safe fallback when AUTO leaks outside a frame
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  return rc.contrastCache.resolve(
    mid,
    rc.shapes,
    rc.shapeOrder,
    rc.pageBackground,
    connectorId
  );
}

/**
 * Resolve a stroke colour at a single point. Used for arrow heads, markers,
 * and labels — anywhere on the connector that needs a concrete colour rather
 * than a per-segment one.
 */
function resolveStrokeAtPoint(
  rawStroke: string | null,
  point: { x: number; y: number },
  connectorId: string
): string | null {
  if (!rawStroke) return rawStroke;
  if (!isAutoColor(rawStroke)) return rawStroke;
  const rc = getRenderContext();
  if (!rc) return '#000000';
  return rc.contrastCache.resolve(
    point,
    rc.shapes,
    rc.shapeOrder,
    rc.pageBackground,
    connectorId
  );
}

/**
 * Get the resolved start point of a connector.
 * If connected to a shape, returns the anchor position.
 * Otherwise returns the stored x, y position.
 */
export function getConnectorStartPoint(
  connector: ConnectorShape,
  shapes: Record<string, Shape>
): Vec2 {
  if (connector.startShapeId) {
    const shape = shapes[connector.startShapeId];
    if (shape && shapeRegistry.hasHandler(shape.type)) {
      const handler = shapeRegistry.getHandler(shape.type);
      if (handler.getAnchors) {
        const anchors = handler.getAnchors(shape);
        const anchor = anchors.find((a) => a.position === connector.startAnchor);
        if (anchor) {
          return new Vec2(anchor.x, anchor.y);
        }
      }
    }
  }
  return new Vec2(connector.x, connector.y);
}

/**
 * Get the resolved end point of a connector.
 * If connected to a shape, returns the anchor position.
 * Otherwise returns the stored x2, y2 position.
 */
export function getConnectorEndPoint(
  connector: ConnectorShape,
  shapes: Record<string, Shape>
): Vec2 {
  if (connector.endShapeId) {
    const shape = shapes[connector.endShapeId];
    if (shape && shapeRegistry.hasHandler(shape.type)) {
      const handler = shapeRegistry.getHandler(shape.type);
      if (handler.getAnchors) {
        const anchors = handler.getAnchors(shape);
        const anchor = anchors.find((a) => a.position === connector.endAnchor);
        if (anchor) {
          return new Vec2(anchor.x, anchor.y);
        }
      }
    }
  }
  return new Vec2(connector.x2, connector.y2);
}

/**
 * Connection health status for a connector endpoint.
 */
export type ConnectionStatus = 'connected' | 'orphaned' | 'missing-anchor' | 'floating';

/**
 * Connection health info for a connector.
 */
export interface ConnectorHealthInfo {
  /** Status of the start connection */
  startStatus: ConnectionStatus;
  /** Status of the end connection */
  endStatus: ConnectionStatus;
  /** Whether the connector is fully healthy */
  isHealthy: boolean;
  /** Human-readable issues (if any) */
  issues: string[];
}

/**
 * Check the health of a connector's connections.
 * Returns info about whether the connector is properly connected.
 */
export function checkConnectorHealth(
  connector: ConnectorShape,
  shapes: Record<string, Shape>
): ConnectorHealthInfo {
  const issues: string[] = [];

  // Check start connection
  let startStatus: ConnectionStatus = 'floating';
  if (connector.startShapeId) {
    const shape = shapes[connector.startShapeId];
    if (!shape) {
      startStatus = 'orphaned';
      issues.push(`Start shape "${connector.startShapeId}" not found`);
    } else if (!shapeRegistry.hasHandler(shape.type)) {
      startStatus = 'connected'; // Handler not yet loaded — assume connected
    } else {
      const handler = shapeRegistry.getHandler(shape.type);
      if (handler.getAnchors) {
        const anchors = handler.getAnchors(shape);
        const anchor = anchors.find((a) => a.position === connector.startAnchor);
        if (anchor) {
          startStatus = 'connected';
        } else {
          startStatus = 'missing-anchor';
          issues.push(`Start anchor "${connector.startAnchor}" not found on shape`);
        }
      } else {
        startStatus = 'connected'; // Shape exists but has no anchors (treat as connected)
      }
    }
  }

  // Check end connection
  let endStatus: ConnectionStatus = 'floating';
  if (connector.endShapeId) {
    const shape = shapes[connector.endShapeId];
    if (!shape) {
      endStatus = 'orphaned';
      issues.push(`End shape "${connector.endShapeId}" not found`);
    } else if (!shapeRegistry.hasHandler(shape.type)) {
      endStatus = 'connected'; // Handler not yet loaded — assume connected
    } else {
      const handler = shapeRegistry.getHandler(shape.type);
      if (handler.getAnchors) {
        const anchors = handler.getAnchors(shape);
        const anchor = anchors.find((a) => a.position === connector.endAnchor);
        if (anchor) {
          endStatus = 'connected';
        } else {
          endStatus = 'missing-anchor';
          issues.push(`End anchor "${connector.endAnchor}" not found on shape`);
        }
      } else {
        endStatus = 'connected'; // Shape exists but has no anchors
      }
    }
  }

  const isHealthy = issues.length === 0;

  return { startStatus, endStatus, isHealthy, issues };
}

/**
 * Find all connectors with connection issues in a document.
 */
export function findOrphanedConnectors(
  shapes: Record<string, Shape>
): Array<{ connector: ConnectorShape; health: ConnectorHealthInfo }> {
  const orphaned: Array<{ connector: ConnectorShape; health: ConnectorHealthInfo }> = [];

  for (const shape of Object.values(shapes)) {
    if (shape.type === 'connector') {
      const connector = shape as ConnectorShape;
      const health = checkConnectorHealth(connector, shapes);
      if (!health.isHealthy) {
        orphaned.push({ connector, health });
      }
    }
  }

  return orphaned;
}

/**
 * Draw an arrow head at the given point in the requested style.
 *
 * `style === 'none'` is a no-op so callers can dispatch unconditionally.
 * Stroke/fill colours must be set on `ctx` before calling.
 */
function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  point: Vec2,
  angle: number,
  size: number,
  style: ArrowStyle,
  strokeWidth: number,
): void {
  if (style === 'none') return;

  const arrowAngle = Math.PI / 6; // 30 degrees
  const cosL = Math.cos(angle - arrowAngle);
  const sinL = Math.sin(angle - arrowAngle);
  const cosR = Math.cos(angle + arrowAngle);
  const sinR = Math.sin(angle + arrowAngle);

  if (style === 'triangle') {
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(point.x - size * cosL, point.y - size * sinL);
    ctx.lineTo(point.x - size * cosR, point.y - size * sinR);
    ctx.closePath();
    ctx.fill();
    return;
  }

  if (style === 'open') {
    // Two unfilled strokes forming a "V" at the endpoint.
    const prevLineWidth = ctx.lineWidth;
    ctx.lineWidth = Math.max(1, strokeWidth);
    ctx.beginPath();
    ctx.moveTo(point.x - size * cosL, point.y - size * sinL);
    ctx.lineTo(point.x, point.y);
    ctx.lineTo(point.x - size * cosR, point.y - size * sinR);
    ctx.stroke();
    ctx.lineWidth = prevLineWidth;
    return;
  }

  if (style === 'diamond') {
    // Tip → side → tail → side → tip, where the tail sits 2× the side offset
    // back along the line so the diamond's long axis aligns with the angle.
    const midX = point.x - size * Math.cos(angle);
    const midY = point.y - size * Math.sin(angle);
    const tailX = point.x - 2 * size * Math.cos(angle);
    const tailY = point.y - 2 * size * Math.sin(angle);
    // Side offset perpendicular-ish: reuse the arrowAngle-derived points but
    // anchor them at the diamond midpoint instead of the tip.
    const sideAx = midX - (size * cosL - size * Math.cos(angle));
    const sideAy = midY - (size * sinL - size * Math.sin(angle));
    const sideBx = midX - (size * cosR - size * Math.cos(angle));
    const sideBy = midY - (size * sinR - size * Math.sin(angle));
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(sideAx, sideAy);
    ctx.lineTo(tailX, tailY);
    ctx.lineTo(sideBx, sideBy);
    ctx.closePath();
    ctx.fill();
    return;
  }
}

/**
 * Draw ERD cardinality symbol at a connector endpoint.
 * The symbol is drawn perpendicular to the line direction.
 *
 * @param ctx - Canvas context
 * @param point - The endpoint position
 * @param angle - The angle of the line approaching this point (in radians)
 * @param cardinality - The cardinality type to draw
 * @param strokeWidth - Base stroke width for scaling
 */
function drawCardinalitySymbol(
  ctx: CanvasRenderingContext2D,
  point: Vec2,
  angle: number,
  cardinality: ERDCardinality,
  strokeWidth: number
): void {
  if (cardinality === 'none') return;

  const size = Math.max(12, strokeWidth * 4);

  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);

  // All symbols drawn with line coming from the left, symbol at origin
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';

  switch (cardinality) {
    case 'one': {
      // Single vertical line
      ctx.beginPath();
      ctx.moveTo(-4, -size / 2);
      ctx.lineTo(-4, size / 2);
      ctx.stroke();
      break;
    }

    case 'many': {
      // Crow's foot (three lines spreading out)
      ctx.beginPath();
      // Center line
      ctx.moveTo(-size, 0);
      ctx.lineTo(0, 0);
      // Top line
      ctx.moveTo(-size, 0);
      ctx.lineTo(0, -size / 2);
      // Bottom line
      ctx.moveTo(-size, 0);
      ctx.lineTo(0, size / 2);
      ctx.stroke();
      break;
    }

    case 'zero-one': {
      // Circle (zero) + vertical line (one)
      const circleRadius = size / 4;
      // Circle
      ctx.beginPath();
      ctx.arc(-size / 2, 0, circleRadius, 0, Math.PI * 2);
      ctx.stroke();
      // Vertical line
      ctx.beginPath();
      ctx.moveTo(-4, -size / 2);
      ctx.lineTo(-4, size / 2);
      ctx.stroke();
      break;
    }

    case 'zero-many': {
      // Circle (zero) + crow's foot (many)
      const circleRadius = size / 4;
      // Circle further back
      ctx.beginPath();
      ctx.arc(-size - circleRadius - 4, 0, circleRadius, 0, Math.PI * 2);
      ctx.stroke();
      // Crow's foot
      ctx.beginPath();
      ctx.moveTo(-size, 0);
      ctx.lineTo(0, 0);
      ctx.moveTo(-size, 0);
      ctx.lineTo(0, -size / 2);
      ctx.moveTo(-size, 0);
      ctx.lineTo(0, size / 2);
      ctx.stroke();
      break;
    }

    case 'one-many': {
      // Vertical line (one) + crow's foot (many)
      // Vertical line further back
      ctx.beginPath();
      ctx.moveTo(-size - 4, -size / 2);
      ctx.lineTo(-size - 4, size / 2);
      ctx.stroke();
      // Crow's foot
      ctx.beginPath();
      ctx.moveTo(-size, 0);
      ctx.lineTo(0, 0);
      ctx.moveTo(-size, 0);
      ctx.lineTo(0, -size / 2);
      ctx.moveTo(-size, 0);
      ctx.lineTo(0, size / 2);
      ctx.stroke();
      break;
    }
  }

  ctx.restore();
}

/**
 * Draw UML class marker at a connector endpoint.
 * The symbol is drawn aligned with the line direction.
 *
 * @param ctx - Canvas context
 * @param point - The endpoint position
 * @param angle - The angle of the line approaching this point (in radians)
 * @param marker - The UML marker type to draw
 * @param strokeWidth - Base stroke width for scaling
 * @param strokeColor - Stroke color for the marker
 * @param fillColor - Fill color for hollow markers (typically background color)
 */
function drawUMLClassMarker(
  ctx: CanvasRenderingContext2D,
  point: Vec2,
  angle: number,
  marker: UMLClassMarker,
  strokeWidth: number,
  strokeColor: string,
  fillColor: string | null
): void {
  if (marker === 'none') return;

  const size = Math.max(12, strokeWidth * 4);

  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (marker) {
    case 'arrow': {
      // Open arrow (V shape, not filled) - for navigable association
      const arrowAngle = Math.PI / 6; // 30 degrees
      ctx.beginPath();
      ctx.moveTo(-size * Math.cos(arrowAngle), -size * Math.sin(arrowAngle));
      ctx.lineTo(0, 0);
      ctx.lineTo(-size * Math.cos(arrowAngle), size * Math.sin(arrowAngle));
      ctx.stroke();
      break;
    }

    case 'triangle':
    case 'triangle-filled': {
      // Hollow or filled triangle - for inheritance/generalization
      const triHeight = size;
      const triWidth = size * 0.7;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-triHeight, -triWidth / 2);
      ctx.lineTo(-triHeight, triWidth / 2);
      ctx.closePath();

      if (marker === 'triangle-filled') {
        ctx.fillStyle = strokeColor;
        ctx.fill();
      } else {
        // Hollow triangle - fill with background color
        ctx.fillStyle = fillColor || '#ffffff';
        ctx.fill();
        ctx.stroke();
      }
      break;
    }

    case 'diamond':
    case 'diamond-filled': {
      // Hollow or filled diamond - for aggregation/composition
      const diamondLength = size;
      const diamondWidth = size * 0.5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-diamondLength / 2, -diamondWidth / 2);
      ctx.lineTo(-diamondLength, 0);
      ctx.lineTo(-diamondLength / 2, diamondWidth / 2);
      ctx.closePath();

      if (marker === 'diamond-filled') {
        ctx.fillStyle = strokeColor;
        ctx.fill();
      } else {
        // Hollow diamond - fill with background color
        ctx.fillStyle = fillColor || '#ffffff';
        ctx.fill();
        ctx.stroke();
      }
      break;
    }

    case 'circle': {
      // Small circle - for interface ball notation
      const radius = size / 3;
      ctx.beginPath();
      ctx.arc(-radius - 2, 0, radius, 0, Math.PI * 2);
      ctx.fillStyle = fillColor || '#ffffff';
      ctx.fill();
      ctx.stroke();
      break;
    }

    case 'socket': {
      // Arc/socket - for interface socket notation (required interface)
      const radius = size / 2;
      ctx.beginPath();
      ctx.arc(-radius, 0, radius, Math.PI / 2, -Math.PI / 2);
      ctx.stroke();
      break;
    }
  }

  ctx.restore();
}

/**
 * Draw UML sequence marker at a connector endpoint.
 * The symbol is drawn aligned with the line direction.
 *
 * @param ctx - Canvas context
 * @param point - The endpoint position
 * @param angle - The angle of the line approaching this point (in radians)
 * @param marker - The UML sequence marker type to draw
 * @param strokeWidth - Base stroke width for scaling
 * @param strokeColor - Stroke color for the marker
 * @param fillColor - Fill color for markers (typically background or stroke color)
 */
function drawUMLSequenceMarker(
  ctx: CanvasRenderingContext2D,
  point: Vec2,
  angle: number,
  marker: UMLSequenceMarker,
  strokeWidth: number,
  strokeColor: string,
  _fillColor: string | null
): void {
  if (marker === 'none') return;

  const size = Math.max(12, strokeWidth * 4);

  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (marker) {
    case 'sync': {
      // Filled triangle arrow - synchronous call
      const arrowAngle = Math.PI / 6; // 30 degrees
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-size * Math.cos(arrowAngle), -size * Math.sin(arrowAngle));
      ctx.lineTo(-size * Math.cos(arrowAngle), size * Math.sin(arrowAngle));
      ctx.closePath();
      ctx.fillStyle = strokeColor;
      ctx.fill();
      break;
    }

    case 'async': {
      // Open arrow (V shape) - asynchronous message
      const arrowAngle = Math.PI / 6; // 30 degrees
      ctx.beginPath();
      ctx.moveTo(-size * Math.cos(arrowAngle), -size * Math.sin(arrowAngle));
      ctx.lineTo(0, 0);
      ctx.lineTo(-size * Math.cos(arrowAngle), size * Math.sin(arrowAngle));
      ctx.stroke();
      break;
    }

    case 'reply': {
      // Open arrow with dashed line indicator - return message
      // The dashed line is handled by lineStyle, just draw open arrow
      const arrowAngle = Math.PI / 6;
      ctx.beginPath();
      ctx.moveTo(-size * Math.cos(arrowAngle), -size * Math.sin(arrowAngle));
      ctx.lineTo(0, 0);
      ctx.lineTo(-size * Math.cos(arrowAngle), size * Math.sin(arrowAngle));
      ctx.stroke();
      break;
    }

    case 'create': {
      // Dashed line with filled arrow - object creation
      // Similar to sync but used with dashed line style
      const arrowAngle = Math.PI / 6;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-size * Math.cos(arrowAngle), -size * Math.sin(arrowAngle));
      ctx.lineTo(-size * Math.cos(arrowAngle), size * Math.sin(arrowAngle));
      ctx.closePath();
      ctx.fillStyle = strokeColor;
      ctx.fill();
      break;
    }

    case 'destroy': {
      // X marker - object destruction
      const xSize = size * 0.6;
      ctx.beginPath();
      ctx.moveTo(-xSize, -xSize);
      ctx.lineTo(xSize, xSize);
      ctx.moveTo(-xSize, xSize);
      ctx.lineTo(xSize, -xSize);
      ctx.stroke();
      break;
    }

    case 'lost': {
      // Filled circle at end - lost message
      const radius = size / 3;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fillStyle = strokeColor;
      ctx.fill();
      break;
    }

    case 'found': {
      // Filled circle at start - found message
      const radius = size / 3;
      ctx.beginPath();
      ctx.arc(-size / 2, 0, radius, 0, Math.PI * 2);
      ctx.fillStyle = strokeColor;
      ctx.fill();
      break;
    }
  }

  ctx.restore();
}

/**
 * Get all points in the connector path (start, waypoints, end).
 */
function getPathPoints(shape: ConnectorShape): Vec2[] {
  const points: Vec2[] = [new Vec2(shape.x, shape.y)];

  if (shape.waypoints && shape.waypoints.length > 0) {
    for (const wp of shape.waypoints) {
      points.push(new Vec2(wp.x, wp.y));
    }
  }

  points.push(new Vec2(shape.x2, shape.y2));
  return points;
}

/**
 * Bisection steps used to refine the box exit onto a non-rectangular shape's
 * true outline. ~2^-12 of the box span — well under a pixel — and only run for
 * shapes whose outline is inset from their bounding box.
 */
const OUTLINE_CLIP_ITERATIONS = 12;

/**
 * Clip a connector endpoint that sits *inside* its bound shape — e.g. the
 * default `center` anchor — to the shape's edge, along the line toward the next
 * path point. This stops the drawn line and arrowhead at the shape's edge
 * instead of spearing through to its centre. Points already on or outside the
 * shape's bounding box (explicit edge anchors, floating endpoints) are returned
 * unchanged (same reference), so callers can cheaply detect a no-op.
 *
 * The box exit is exact for rectangles. For shapes whose outline is inset from
 * their bounding box — decision diamonds, ellipses, other library shapes — the
 * box exit lands outside the shape, so it is refined onto the true outline by
 * bisecting the handler's hit test along the ray (JP-302).
 */
export function clipPointToShapeBoundary(from: Vec2, toward: Vec2, shape: Shape): Vec2 {
  if (!shapeRegistry.hasHandler(shape.type)) return from;
  const handler = shapeRegistry.getHandler(shape.type);
  const bounds = handler.getBounds(shape);

  const inside =
    from.x > bounds.minX &&
    from.x < bounds.maxX &&
    from.y > bounds.minY &&
    from.y < bounds.maxY;
  if (!inside) return from;

  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  if (dx === 0 && dy === 0) return from;

  // Smallest positive parameter where the ray from `from` exits the box.
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (bounds.maxX - from.x) / dx);
  else if (dx < 0) t = Math.min(t, (bounds.minX - from.x) / dx);
  if (dy > 0) t = Math.min(t, (bounds.maxY - from.y) / dy);
  else if (dy < 0) t = Math.min(t, (bounds.minY - from.y) / dy);

  if (!Number.isFinite(t) || t <= 0) return from;
  const boxExit = new Vec2(from.x + t * dx, from.y + t * dy);

  // Rectangles fill their box, so the box exit is the answer. For inset outlines
  // it falls outside the shape; refine onto the true edge. `from` is interior,
  // `boxExit` is outside the outline — bisect for the crossing.
  if (handler.hitTest(shape, boxExit)) return boxExit;

  let insidePt: Vec2 = from;
  let outsidePt: Vec2 = boxExit;
  for (let i = 0; i < OUTLINE_CLIP_ITERATIONS; i++) {
    const mid = new Vec2((insidePt.x + outsidePt.x) / 2, (insidePt.y + outsidePt.y) / 2);
    if (handler.hitTest(shape, mid)) insidePt = mid;
    else outsidePt = mid;
  }
  return outsidePt;
}

/**
 * Clip a connector's first and last path points to their bound shapes'
 * boundaries (see {@link clipPointToShapeBoundary}). Returns the input array
 * unchanged when neither endpoint needs clipping.
 */
export function clipConnectorEndpoints(
  points: Vec2[],
  shape: ConnectorShape,
  shapes: Record<string, Shape>
): Vec2[] {
  if (points.length < 2) return points;
  let result = points;

  if (shape.startShapeId) {
    const startShape = shapes[shape.startShapeId];
    if (startShape && startShape.type !== 'connector') {
      const clipped = clipPointToShapeBoundary(points[0]!, points[1]!, startShape);
      if (clipped !== points[0]) {
        if (result === points) result = [...points];
        result[0] = clipped;
      }
    }
  }

  const last = points.length - 1;
  if (shape.endShapeId) {
    const endShape = shapes[shape.endShapeId];
    if (endShape && endShape.type !== 'connector') {
      const clipped = clipPointToShapeBoundary(points[last]!, points[last - 1]!, endShape);
      if (clipped !== points[last]) {
        if (result === points) result = [...points];
        result[last] = clipped;
      }
    }
  }

  return result;
}

/**
 * Calculate the total length of a path.
 */
function calculatePathLength(points: Vec2[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    length += Vec2.distance(prev, curr);
  }
  return length;
}

/**
 * Get a point along the path at position t (0-1).
 */
function getPointAlongPath(points: Vec2[], t: number): { point: Vec2; angle: number } {
  if (points.length < 2) {
    return { point: points[0] ?? new Vec2(0, 0), angle: 0 };
  }

  const totalLength = calculatePathLength(points);
  const targetLength = t * totalLength;

  let accumulatedLength = 0;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const segmentLength = Vec2.distance(prev, curr);

    if (accumulatedLength + segmentLength >= targetLength) {
      // Found the segment
      const segmentT = (targetLength - accumulatedLength) / segmentLength;
      const x = prev.x + segmentT * (curr.x - prev.x);
      const y = prev.y + segmentT * (curr.y - prev.y);
      const angle = Math.atan2(curr.y - prev.y, curr.x - prev.x);
      return { point: new Vec2(x, y), angle };
    }

    accumulatedLength += segmentLength;
  }

  // Return end point
  const lastIdx = points.length - 1;
  const lastPoint = points[lastIdx]!;
  const secondLastPoint = points[lastIdx - 1]!;
  const angle = Math.atan2(
    lastPoint.y - secondLastPoint.y,
    lastPoint.x - secondLastPoint.x
  );
  return { point: lastPoint, angle };
}

/**
 * Render a connector label with optional background.
 */
function renderConnectorLabel(
  ctx: CanvasRenderingContext2D,
  label: string,
  position: Vec2,
  fontSize: number,
  color: string,
  backgroundColor?: string,
  offsetX: number = 0,
  offsetY: number = 0,
  overflow?: LabelOverflow
): void {
  // Background tri-state, resolved here so the label engine stays generic:
  //   undefined            → legacy default white pill (with subtle border)
  //   '' (or 'transparent') → user chose No Fill; no pill
  //   <colour>             → that colour, no border
  const noBackground = backgroundColor === '' || backgroundColor === 'transparent';
  const usingDefault = backgroundColor === undefined;
  const pillColor = noBackground ? undefined : backgroundColor || 'rgba(255, 255, 255, 0.9)';

  ctx.save();
  ctx.translate(position.x, position.y);
  renderLabel(ctx, {
    text: label,
    spec: CONNECTOR_LABEL_SPEC,
    overflow,
    // Bound the label width so long text wraps to a finite pill instead of
    // stretching indefinitely; height allows a few wrapped lines before clip.
    boxWidth: CONNECTOR_LABEL_MAX_WIDTH,
    boxHeight: fontSize * 6,
    fontSize,
    color,
    background: pillColor,
    backgroundBorder: usingDefault,
    backgroundPadX: 8,
    backgroundPadY: 8,
    anchor: { textAlign: 'center', textBaseline: 'middle' },
    offsetX,
    offsetY,
  });
  ctx.restore();
}

/**
 * Calculate point-to-line-segment distance.
 */
function pointToLineDistance(point: Vec2, lineStart: Vec2, lineEnd: Vec2): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    // Line segment is a point
    return Vec2.distance(point, lineStart);
  }

  // Calculate projection of point onto line
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lengthSquared
    )
  );

  const projection = new Vec2(lineStart.x + t * dx, lineStart.y + t * dy);

  return Vec2.distance(point, projection);
}

/**
 * Connector shape handler implementation.
 */
export const connectorHandler: ShapeHandler<ConnectorShape> = {
  /**
   * Render a connector to the canvas context.
   * Note: This method needs access to all shapes to resolve endpoints.
   * The actual rendering uses cached x, y, x2, y2 values.
   */
  render(ctx: CanvasRenderingContext2D, shape: ConnectorShape): void {
    const { stroke, strokeWidth, opacity, lineStyle, flowType } = shape;
    const startArrowStyle = resolveArrowStyle(shape, 'start');
    const endArrowStyle = resolveArrowStyle(shape, 'end');

    ctx.save();
    ctx.globalAlpha = opacity;

    // Get all path points (handle self-message routing)
    let points = getPathPoints(shape);

    // Clip endpoints bound to a shape with an interior anchor (the default
    // 'center') to that shape's edge, so the line/arrowhead touch the boundary
    // instead of running to the centre. Needs the live shapes from the render
    // context; outside a frame the raw points are used.
    const renderCtx = getRenderContext();
    if (renderCtx) {
      points = clipConnectorEndpoints(points, shape, renderCtx.shapes);
    }

    // Self-message routing: when both endpoints connect to the same shape
    // Route the connector as a loop to the right
    if (shape.startShapeId && shape.startShapeId === shape.endShapeId && points.length === 2) {
      const start = points[0]!;
      const end = points[1]!;
      const loopWidth = shape.selfMessageWidth ?? 30;
      const loopHeight = Math.abs(end.y - start.y) || 40;

      // Create a loop that goes to the right and down
      points = [
        start,
        new Vec2(start.x + loopWidth, start.y),
        new Vec2(start.x + loopWidth, start.y + loopHeight),
        new Vec2(end.x, end.y),
      ];
    }

    // Draw the line(s)
    if (stroke && strokeWidth > 0 && points.length >= 2) {
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Apply line style: flowType 'object' uses dashed, otherwise use lineStyle
      const effectiveLineStyle = flowType === 'object' ? 'dashed' : lineStyle;
      if (effectiveLineStyle === 'dashed') {
        ctx.setLineDash([8, 4]);
      } else {
        ctx.setLineDash([]);
      }

      if (isAutoColor(stroke)) {
        // Per-segment colour resolution so a connector crossing dark→light
        // backgrounds gets the right contrast on each leg.
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1]!;
          const b = points[i]!;
          ctx.strokeStyle = resolveSegmentStroke(stroke, a, b, shape.id);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      } else {
        ctx.strokeStyle = stroke;
        const firstPoint = points[0]!;
        ctx.beginPath();
        ctx.moveTo(firstPoint.x, firstPoint.y);
        for (let i = 1; i < points.length; i++) {
          const pt = points[i]!;
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();
      }

      // Reset dash for markers (they should always be solid)
      ctx.setLineDash([]);

      // Calculate angles for arrows/cardinality/markers
      const arrowSize = strokeWidth * 4;

      // Infer connectorType for backwards compatibility
      // Priority: sequence markers > cardinality > UML class markers
      // If sequence markers are set but no connectorType, treat as 'uml-sequence'
      // If cardinality is set but no connectorType, treat as 'erd'
      // If UML class markers are set but no connectorType, treat as 'uml-class'
      const connectorType = shape.connectorType ||
        ((shape.startSequenceMarker || shape.endSequenceMarker) ? 'uml-sequence' :
        ((shape.startCardinality || shape.endCardinality) ? 'erd' :
        ((shape.startUMLMarker || shape.endUMLMarker) ? 'uml-class' : 'default')));

      // Draw start endpoint
      // Priority: UML sequence markers > UML class markers > ERD cardinality > arrows
      if (points.length >= 2) {
        const p0 = points[0]!;
        const p1 = points[1]!;
        const startAngle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        const startStroke = resolveStrokeAtPoint(stroke, p0, shape.id) ?? stroke;

        if (connectorType === 'uml-sequence' && shape.startSequenceMarker && shape.startSequenceMarker !== 'none') {
          // Draw UML sequence marker
          drawUMLSequenceMarker(ctx, p0, startAngle + Math.PI, shape.startSequenceMarker, strokeWidth, startStroke, shape.fill);
        } else if (connectorType === 'uml-class' && shape.startUMLMarker && shape.startUMLMarker !== 'none') {
          // Draw UML class marker
          drawUMLClassMarker(ctx, p0, startAngle + Math.PI, shape.startUMLMarker, strokeWidth, startStroke, shape.fill);
        } else if (connectorType === 'erd' && shape.startCardinality && shape.startCardinality !== 'none') {
          // Draw ERD cardinality symbol
          ctx.strokeStyle = startStroke;
          drawCardinalitySymbol(ctx, p0, startAngle + Math.PI, shape.startCardinality, strokeWidth);
        } else if (startArrowStyle !== 'none') {
          // Draw regular arrowhead in the chosen style.
          ctx.fillStyle = startStroke;
          ctx.strokeStyle = startStroke;
          drawArrowHead(ctx, p0, startAngle + Math.PI, arrowSize, startArrowStyle, strokeWidth);
        }
      }

      // Draw end endpoint
      // Priority: UML sequence markers > UML class markers > ERD cardinality > arrows
      if (points.length >= 2) {
        const lastIdx = points.length - 1;
        const lastPt = points[lastIdx]!;
        const secondLastPt = points[lastIdx - 1]!;
        const endAngle = Math.atan2(lastPt.y - secondLastPt.y, lastPt.x - secondLastPt.x);
        const endStroke = resolveStrokeAtPoint(stroke, lastPt, shape.id) ?? stroke;

        if (connectorType === 'uml-sequence' && shape.endSequenceMarker && shape.endSequenceMarker !== 'none') {
          // Draw UML sequence marker
          drawUMLSequenceMarker(ctx, lastPt, endAngle, shape.endSequenceMarker, strokeWidth, endStroke, shape.fill);
        } else if (connectorType === 'uml-class' && shape.endUMLMarker && shape.endUMLMarker !== 'none') {
          // Draw UML class marker
          drawUMLClassMarker(ctx, lastPt, endAngle, shape.endUMLMarker, strokeWidth, endStroke, shape.fill);
        } else if (connectorType === 'erd' && shape.endCardinality && shape.endCardinality !== 'none') {
          // Draw ERD cardinality symbol
          ctx.strokeStyle = endStroke;
          drawCardinalitySymbol(ctx, lastPt, endAngle, shape.endCardinality, strokeWidth);
        } else if (endArrowStyle !== 'none') {
          // Draw regular arrowhead in the chosen style.
          ctx.fillStyle = endStroke;
          ctx.strokeStyle = endStroke;
          drawArrowHead(ctx, lastPt, endAngle, arrowSize, endArrowStyle, strokeWidth);
        }
      }
    }

    // Draw message number if present (for sequence diagrams)
    if (shape.messageNumber && shape.messageNumber.trim()) {
      const { point, angle } = getPointAlongPath(points, 0.1); // Near the start
      const fontSize = shape.labelFontSize ?? 12;
      const rawColor = shape.labelColor ?? stroke ?? '#000000';
      const color = resolveStrokeAtPoint(rawColor, point, shape.id) ?? rawColor;

      ctx.save();
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = color;

      // Position above the line
      const offsetY = -8;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const perpX = -sin * offsetY;
      const perpY = cos * offsetY;

      ctx.fillText(shape.messageNumber + ':', point.x + perpX, point.y + perpY);
      ctx.restore();
    }

    // Draw label if present
    if (shape.label && shape.label.trim()) {
      const labelPosition = shape.labelPosition ?? 0.5;
      const { point } = getPointAlongPath(points, labelPosition);
      const fontSize = shape.labelFontSize ?? 12;
      const rawColor = shape.labelColor ?? stroke ?? '#000000';
      const color = resolveStrokeAtPoint(rawColor, point, shape.id) ?? rawColor;
      const backgroundColor = shape.labelBackground;
      const offsetX = shape.labelOffsetX ?? 0;
      const offsetY = shape.labelOffsetY ?? 0;

      renderConnectorLabel(ctx, shape.label, point, fontSize, color, backgroundColor, offsetX, offsetY, shape.labelOverflow);
    }

    // Draw guard condition if present (for activity diagrams)
    if (shape.guardCondition && shape.guardCondition.trim()) {
      const guardPosition = shape.guardPosition ?? 0.2; // Near the start by default
      const { point } = getPointAlongPath(points, guardPosition);
      const fontSize = shape.labelFontSize ?? 12;
      const rawColor = shape.labelColor ?? stroke ?? '#000000';
      const color = resolveStrokeAtPoint(rawColor, point, shape.id) ?? rawColor;
      const guardText = `[${shape.guardCondition}]`;

      ctx.save();
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';

      // Draw with white background for readability
      const metrics = ctx.measureText(guardText);
      const padding = 2;
      const bgWidth = metrics.width + padding * 2;
      const bgHeight = fontSize + padding;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillRect(
        point.x - bgWidth / 2,
        point.y - bgHeight - 4,
        bgWidth,
        bgHeight
      );

      ctx.fillStyle = color;
      ctx.fillText(guardText, point.x, point.y - 6);
      ctx.restore();
    }

    ctx.restore();
  },

  /**
   * Test if a world point is on the connector line (or any segment).
   */
  hitTest(shape: ConnectorShape, worldPoint: Vec2): boolean {
    const points = getPathPoints(shape);
    const hitTolerance = Math.max(5, shape.strokeWidth);

    // Check each line segment
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]!;
      const curr = points[i]!;
      const distance = pointToLineDistance(worldPoint, prev, curr);
      if (distance <= hitTolerance) {
        return true;
      }
    }

    return false;
  },

  /**
   * Get the axis-aligned bounding box of the connector (including all waypoints).
   */
  getBounds(shape: ConnectorShape): Box {
    const points = getPathPoints(shape);
    const { strokeWidth } = shape;
    const padding = strokeWidth / 2 + 5; // Extra padding for arrows

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

    return new Box(minX - padding, minY - padding, maxX + padding, maxY + padding);
  },

  /**
   * Get the handles for the connector (start and end points).
   */
  getHandles(shape: ConnectorShape): Handle[] {
    return [
      {
        type: 'left',
        x: shape.x,
        y: shape.y,
        cursor: 'move',
      },
      {
        type: 'right',
        x: shape.x2,
        y: shape.y2,
        cursor: 'move',
      },
    ];
  },

  /**
   * Create a new connector at the given position.
   */
  create(position: Vec2, id: string): ConnectorShape {
    return {
      id,
      type: 'connector',
      x: position.x,
      y: position.y,
      x2: position.x + 100,
      y2: position.y,
      rotation: DEFAULT_CONNECTOR.rotation,
      opacity: DEFAULT_CONNECTOR.opacity,
      locked: DEFAULT_CONNECTOR.locked,
      visible: DEFAULT_CONNECTOR.visible,
      fill: DEFAULT_CONNECTOR.fill,
      stroke: DEFAULT_CONNECTOR.stroke,
      strokeWidth: DEFAULT_CONNECTOR.strokeWidth,
      startShapeId: DEFAULT_CONNECTOR.startShapeId,
      startAnchor: DEFAULT_CONNECTOR.startAnchor,
      endShapeId: DEFAULT_CONNECTOR.endShapeId,
      endAnchor: DEFAULT_CONNECTOR.endAnchor,
      startArrow: DEFAULT_CONNECTOR.startArrow,
      endArrow: DEFAULT_CONNECTOR.endArrow,
      routingMode: DEFAULT_CONNECTOR.routingMode,
    };
  },

  /**
   * In-place label edit target: the mid-path point (or `labelPosition` along
   * the route), so double-click edits a connector's midpoint label (JP-102).
   */
  getLabelEditTarget(shape: ConnectorShape) {
    const points = getPathPoints(shape);
    const t = shape.labelPosition ?? 0.5;
    const { point } = getPointAlongPath(points, t);
    const fontSize = shape.labelFontSize ?? 12;
    return {
      field: 'label' as const,
      worldRect: {
        cx: point.x + (shape.labelOffsetX ?? 0),
        cy: point.y + (shape.labelOffsetY ?? 0),
        width: 120,
        height: fontSize * 1.5,
      },
      fontSize,
      align: 'center' as const,
      rotation: 0,
    };
  },
};

// Register the connector handler
shapeRegistry.register('connector', connectorHandler);

/**
 * Update connector endpoints based on connected shapes.
 * Call this when shapes move to keep connectors attached.
 */
export function updateConnectorEndpoints(
  connector: ConnectorShape,
  shapes: Record<string, Shape>
): Partial<ConnectorShape> {
  const updates: Partial<ConnectorShape> = {};

  // Update start point if connected
  if (connector.startShapeId) {
    const startPoint = getConnectorStartPoint(connector, shapes);
    updates.x = startPoint.x;
    updates.y = startPoint.y;
  }

  // Update end point if connected
  if (connector.endShapeId) {
    const endPoint = getConnectorEndPoint(connector, shapes);
    updates.x2 = endPoint.x;
    updates.y2 = endPoint.y;
  }

  return updates;
}

/**
 * Find the closest anchor on a shape to a given point.
 */
export function findClosestAnchor(
  shape: Shape,
  point: Vec2,
  maxDistance: number = Infinity
): { anchor: Anchor; distance: number } | null {
  if (!shapeRegistry.hasHandler(shape.type)) return null;
  const handler = shapeRegistry.getHandler(shape.type);
  if (!handler.getAnchors) return null;

  const anchors = handler.getAnchors(shape);
  let closest: { anchor: Anchor; distance: number } | null = null;

  for (const anchor of anchors) {
    const distance = Vec2.distance(new Vec2(anchor.x, anchor.y), point);
    if (distance <= maxDistance && (!closest || distance < closest.distance)) {
      closest = { anchor, distance };
    }
  }

  return closest;
}
