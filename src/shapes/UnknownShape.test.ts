/**
 * An older build keeps working around shape types a newer one wrote (DSK-235):
 * it measures, draws, hit-tests, snaps to, routes around and exports them
 * instead of throwing, and it never creates one.
 */
import { describe, it, expect } from 'vitest';
import { Vec2 } from '../math/Vec2';
import { shapeRegistry } from './ShapeRegistry';
import { unknownShapeHandler, unknownShapeBounds, UNKNOWN_SHAPE_FALLBACK_SIZE } from './UnknownShape';
import { snapToShapes } from '../engine/Snapping';
import { calculateConnectorWaypoints } from '../engine/OrthogonalRouter';
import { exportToSvg } from '../utils/exportUtils';
import type { ConnectorShape, RectangleShape, Shape } from './Shape';
import './Rectangle';
import './Connector';

/** A shape of a type no build has registered, as a newer version might write it. */
const stroke = {
  id: 'stroke', type: 'pen-stroke-from-the-future', x: 200, y: 0, width: 80, height: 220,
  rotation: 0, opacity: 1, locked: false, visible: true, fill: null, stroke: '#000000', strokeWidth: 2,
  points: [[0, 0, 0.5], [10, 4, 0.6]],
} as unknown as Shape;

/** The rectangle occupying exactly the stroke's box (no stroke, which would widen its bounds). */
const sameBox: RectangleShape = {
  id: 'blocker', type: 'rectangle', x: 200, y: 0, width: 80, height: 220, rotation: 0, opacity: 1,
  locked: false, visible: true, fill: '#4a90d9', stroke: '#2c5282', strokeWidth: 0, cornerRadius: 0,
};

const connector = {
  id: 'conn', type: 'connector', x: 0, y: 0, x2: 400, y2: 0, rotation: 0, opacity: 1,
  locked: false, visible: true, fill: null, stroke: '#333333', strokeWidth: 2,
  startShapeId: null, endShapeId: null, startAnchor: 'center', endAnchor: 'center',
  startArrow: false, endArrow: true, routingMode: 'orthogonal',
} as ConnectorShape;

/** A 2D context that records the methods called on it. */
function recordingContext(calls: string[]): CanvasRenderingContext2D {
  return new Proxy({}, {
    get: (_target, prop) =>
      typeof prop === 'string'
        ? (..._args: unknown[]) => {
            calls.push(prop);
          }
        : undefined,
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
}

describe('a shape type this build does not know (DSK-235)', () => {
  it('gets the stand-in handler, while hasHandler still says the type is unknown', () => {
    expect(shapeRegistry.hasHandler(stroke.type)).toBe(false);
    expect(shapeRegistry.getHandler(stroke.type)).toBe(unknownShapeHandler);
    expect(shapeRegistry.getHandlerForShape(stroke)).toBe(unknownShapeHandler);
    expect(shapeRegistry.getHandler('rectangle')).not.toBe(unknownShapeHandler);
  });

  it('is measured from its centre and size', () => {
    const b = unknownShapeBounds(stroke);
    expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual([160, -110, 240, 110]);
  });

  it('gets a fixed size when its width or height is missing or not a number', () => {
    const b = unknownShapeBounds({ ...stroke, width: undefined, height: 'tall' } as unknown as Shape);
    expect([b.width, b.height]).toEqual([UNKNOWN_SHAPE_FALLBACK_SIZE, UNKNOWN_SHAPE_FALLBACK_SIZE]);
    const bare = unknownShapeBounds({ id: 'bare', type: 'mystery' } as unknown as Shape);
    expect([bare.minX, bare.maxX]).toEqual([-UNKNOWN_SHAPE_FALLBACK_SIZE / 2, UNKNOWN_SHAPE_FALLBACK_SIZE / 2]);
  });

  it('is hit inside its box and not outside it', () => {
    expect(unknownShapeHandler.hitTest(stroke, new Vec2(200, 100))).toBe(true);
    expect(unknownShapeHandler.hitTest(stroke, new Vec2(250, 0))).toBe(false);
  });

  it('offers no resize handles and refuses to be created', () => {
    expect(unknownShapeHandler.getHandles(stroke)).toEqual([]);
    expect(() => unknownShapeHandler.create(new Vec2(0, 0), 'new')).toThrow();
  });

  it('draws a dashed outline with its notice', () => {
    const calls: string[] = [];
    unknownShapeHandler.render(recordingContext(calls), stroke);
    expect(calls).toEqual(expect.arrayContaining(['setLineDash', 'strokeRect', 'fillText']));
  });

  it('can be snapped to while dragging', () => {
    // 2 units from its left edge (160), well inside the threshold.
    const result = snapToShapes(new Vec2(162, 300), { stroke }, ['stroke'], 5, new Set());
    expect(result.snappedX).toBe(true);
    expect(result.position.x).toBe(160);
  });

  it('is routed around exactly like a rectangle with the same box', () => {
    const around = calculateConnectorWaypoints(connector, { stroke, conn: connector });
    const aroundRect = calculateConnectorWaypoints(connector, { blocker: sameBox, conn: connector });
    expect(around).toBeDefined();
    expect(around).toEqual(aroundRect);
  });

  it('exports to SVG as a placeholder in its box', () => {
    const svg = exportToSvg(
      { shapes: { stroke }, shapeOrder: ['stroke'], selectedIds: [] },
      { format: 'svg', scope: 'all', scale: 1, background: null, padding: 0, filename: 'test' },
    );
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="80"');
  });
});
