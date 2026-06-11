/**
 * Tests for Connector shape handler and related utilities.
 *
 * Tests the connector rendering, hit testing, and UML diagram features.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Vec2 } from '../math/Vec2';
import {
  connectorHandler,
  getConnectorStartPoint,
  getConnectorEndPoint,
  checkConnectorHealth,
  findOrphanedConnectors,
  findClosestAnchor,
  updateConnectorEndpoints,
  clipPointToShapeBoundary,
  clipConnectorEndpoints,
} from './Connector';
import { ConnectorShape, RectangleShape, Shape, resolveArrowStyle } from './Shape';
import { setRenderContext } from '../engine/RenderContext';
import { ContrastCache } from '../engine/ContrastResolver';
// Import shape handlers to register them
import './Rectangle';
import './Ellipse';

/**
 * Helper to create a test connector shape.
 */
function createTestConnector(overrides: Partial<ConnectorShape> = {}): ConnectorShape {
  return {
    id: 'test-connector',
    type: 'connector',
    x: 0,
    y: 0,
    x2: 100,
    y2: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: null,
    stroke: '#000000',
    strokeWidth: 2,
    startShapeId: null,
    startAnchor: 'center',
    endShapeId: null,
    endAnchor: 'center',
    startArrow: false,
    endArrow: true,
    ...overrides,
  };
}

/**
 * Helper to create a mock CanvasRenderingContext2D.
 */
function createMockContext(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    setLineDash: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    measureText: vi.fn().mockReturnValue({ width: 50 }),
    translate: vi.fn(),
    rotate: vi.fn(),
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
  } as unknown as CanvasRenderingContext2D;
}

describe('connectorHandler', () => {
  describe('render', () => {
    it('renders a basic connector line', () => {
      const ctx = createMockContext();
      const connector = createTestConnector();

      connectorHandler.render(ctx, connector);

      expect(ctx.save).toHaveBeenCalled();
      expect(ctx.beginPath).toHaveBeenCalled();
      expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
      expect(ctx.lineTo).toHaveBeenCalledWith(100, 0);
      expect(ctx.stroke).toHaveBeenCalled();
      expect(ctx.restore).toHaveBeenCalled();
    });

    it('renders a connector with dashed line style', () => {
      const ctx = createMockContext();
      const connector = createTestConnector({ lineStyle: 'dashed' });

      connectorHandler.render(ctx, connector);

      expect(ctx.setLineDash).toHaveBeenCalledWith([8, 4]);
    });

    it('renders object flow with dashed line', () => {
      const ctx = createMockContext();
      const connector = createTestConnector({ flowType: 'object' });

      connectorHandler.render(ctx, connector);

      expect(ctx.setLineDash).toHaveBeenCalledWith([8, 4]);
    });

    it('renders control flow with solid line', () => {
      const ctx = createMockContext();
      const connector = createTestConnector({ flowType: 'control' });

      connectorHandler.render(ctx, connector);

      expect(ctx.setLineDash).toHaveBeenCalledWith([]);
    });

    it('renders a connector label at midpoint', () => {
      const ctx = createMockContext();
      const connector = createTestConnector({ label: 'Test Label' });

      connectorHandler.render(ctx, connector);

      expect(ctx.fillText).toHaveBeenCalledWith('Test Label', expect.any(Number), expect.any(Number));
    });

    it('renders guard condition with brackets', () => {
      const ctx = createMockContext();
      const connector = createTestConnector({ guardCondition: 'x > 0' });

      connectorHandler.render(ctx, connector);

      expect(ctx.fillText).toHaveBeenCalledWith('[x > 0]', expect.any(Number), expect.any(Number));
    });

    it('renders guard condition at custom position', () => {
      const ctx = createMockContext();
      const connector = createTestConnector({
        guardCondition: 'valid',
        guardPosition: 0.8,
      });

      connectorHandler.render(ctx, connector);

      expect(ctx.fillText).toHaveBeenCalled();
    });

    it('renders message number for sequence diagrams', () => {
      const ctx = createMockContext();
      const connector = createTestConnector({ messageNumber: '1.2' });

      connectorHandler.render(ctx, connector);

      expect(ctx.fillText).toHaveBeenCalledWith('1.2:', expect.any(Number), expect.any(Number));
    });

    it('handles self-message routing', () => {
      const ctx = createMockContext();
      const connector = createTestConnector({
        startShapeId: 'shape-1',
        endShapeId: 'shape-1',
        x: 50,
        y: 0,
        x2: 50,
        y2: 40,
        selfMessageWidth: 30,
      });

      connectorHandler.render(ctx, connector);

      // Should render the connector (moveTo and lineTo calls)
      expect(ctx.moveTo).toHaveBeenCalled();
      expect(ctx.lineTo).toHaveBeenCalled();
      // At minimum 3 lineTo calls for 4-point loop path
      expect((ctx.lineTo as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('uses default selfMessageWidth when not specified', () => {
      const ctx = createMockContext();
      const connector = createTestConnector({
        startShapeId: 'shape-1',
        endShapeId: 'shape-1',
        x: 50,
        y: 0,
        x2: 50,
        y2: 40,
      });

      connectorHandler.render(ctx, connector);

      // Should still render with default width of 30
      expect(ctx.lineTo).toHaveBeenCalled();
    });

    // ── Bidirectional arrow rendering (Phase 19.2) ─────────────────────────
    it('draws a filled arrowhead when endArrowStyle is "triangle"', () => {
      const ctx = createMockContext();
      const connector = createTestConnector({ endArrowStyle: 'triangle' });
      connectorHandler.render(ctx, connector);
      // Triangle is a filled polygon. The body line also calls stroke, so we
      // assert on fill instead — it only fires for arrowheads/labels here.
      expect(ctx.fill).toHaveBeenCalled();
    });

    it('strokes (but does not fill) the open arrowhead', () => {
      const ctx = createMockContext();
      // Start with no end arrow so the only "open" head is at the start.
      const connector = createTestConnector({
        startArrowStyle: 'open',
        endArrowStyle: 'none',
      });
      const fillCallsBefore = (ctx.fill as ReturnType<typeof vi.fn>).mock.calls.length;
      connectorHandler.render(ctx, connector);
      expect((ctx.fill as ReturnType<typeof vi.fn>).mock.calls.length).toBe(fillCallsBefore);
      // The open head adds two stroke calls on top of the body line.
      expect((ctx.stroke as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    });

    it('omits the arrowhead entirely when style is "none"', () => {
      const ctx = createMockContext();
      const connector = createTestConnector({
        startArrowStyle: 'none',
        endArrowStyle: 'none',
      });
      connectorHandler.render(ctx, connector);
      // Body line uses stroke once; with both heads off, no fill should fire.
      expect(ctx.fill).not.toHaveBeenCalled();
    });

    it('falls back to the legacy startArrow/endArrow booleans for old documents', () => {
      const ctx = createMockContext();
      // Simulate a pre-19.2 doc: style fields absent, only legacy booleans.
      const connector = createTestConnector({ startArrow: true, endArrow: false });
      connectorHandler.render(ctx, connector);
      // A legacy `startArrow: true` resolves to "triangle" → filled head.
      expect(ctx.fill).toHaveBeenCalled();
    });
  });

  describe('hitTest', () => {
    it('returns true for point on line', () => {
      const connector = createTestConnector();
      const result = connectorHandler.hitTest(connector, new Vec2(50, 0));
      expect(result).toBe(true);
    });

    it('returns true for point within tolerance', () => {
      const connector = createTestConnector();
      const result = connectorHandler.hitTest(connector, new Vec2(50, 4));
      expect(result).toBe(true);
    });

    it('returns false for point far from line', () => {
      const connector = createTestConnector();
      const result = connectorHandler.hitTest(connector, new Vec2(50, 50));
      expect(result).toBe(false);
    });

    it('handles orthogonal connectors with waypoints', () => {
      const connector = createTestConnector({
        waypoints: [{ x: 50, y: 0 }, { x: 50, y: 50 }],
        x2: 100,
        y2: 50,
      });
      const result = connectorHandler.hitTest(connector, new Vec2(50, 25));
      expect(result).toBe(true);
    });
  });

  describe('getBounds', () => {
    it('returns correct bounds for horizontal connector', () => {
      const connector = createTestConnector();
      const bounds = connectorHandler.getBounds(connector);

      expect(bounds.minX).toBeLessThan(0);
      expect(bounds.minY).toBeLessThan(0);
      expect(bounds.maxX).toBeGreaterThan(100);
      expect(bounds.maxY).toBeGreaterThan(0);
    });

    it('includes waypoints in bounds calculation', () => {
      const connector = createTestConnector({
        waypoints: [{ x: 50, y: -50 }, { x: 50, y: 50 }],
      });
      const bounds = connectorHandler.getBounds(connector);

      expect(bounds.minY).toBeLessThan(-50);
      expect(bounds.maxY).toBeGreaterThan(50);
    });
  });

  describe('getHandles', () => {
    it('returns start and end handles', () => {
      const connector = createTestConnector();
      const handles = connectorHandler.getHandles(connector);

      expect(handles).toHaveLength(2);
      expect(handles[0]?.type).toBe('left');
      expect(handles[0]?.x).toBe(0);
      expect(handles[0]?.y).toBe(0);
      expect(handles[1]?.type).toBe('right');
      expect(handles[1]?.x).toBe(100);
      expect(handles[1]?.y).toBe(0);
    });
  });

  describe('create', () => {
    it('creates connector at specified position', () => {
      const connector = connectorHandler.create(new Vec2(50, 100), 'new-connector');

      expect(connector.id).toBe('new-connector');
      expect(connector.x).toBe(50);
      expect(connector.y).toBe(100);
      expect(connector.x2).toBe(150); // 100px to the right
      expect(connector.y2).toBe(100);
    });
  });
});

describe('connector utility functions', () => {
  let shapes: Record<string, Shape>;
  let testRect: RectangleShape;

  beforeEach(() => {
    testRect = {
      id: 'rect-1',
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 80,
      height: 60,
      cornerRadius: 0,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      fill: '#ffffff',
      stroke: '#000000',
      strokeWidth: 2,
    };
    shapes = { 'rect-1': testRect };
  });

  describe('getConnectorStartPoint', () => {
    it('returns stored position when not connected', () => {
      const connector = createTestConnector({ x: 25, y: 75 });
      const point = getConnectorStartPoint(connector, shapes);
      expect(point.x).toBe(25);
      expect(point.y).toBe(75);
    });

    it('returns anchor position when connected to shape', () => {
      const connector = createTestConnector({
        startShapeId: 'rect-1',
        startAnchor: 'center',
      });
      const point = getConnectorStartPoint(connector, shapes);
      expect(point.x).toBe(100);
      expect(point.y).toBe(100);
    });

    it('falls back to stored position when shape not found', () => {
      const connector = createTestConnector({
        startShapeId: 'nonexistent',
        x: 50,
        y: 50,
      });
      const point = getConnectorStartPoint(connector, shapes);
      expect(point.x).toBe(50);
      expect(point.y).toBe(50);
    });
  });

  describe('getConnectorEndPoint', () => {
    it('returns stored position when not connected', () => {
      const connector = createTestConnector({ x2: 200, y2: 150 });
      const point = getConnectorEndPoint(connector, shapes);
      expect(point.x).toBe(200);
      expect(point.y).toBe(150);
    });

    it('returns anchor position when connected to shape', () => {
      const connector = createTestConnector({
        endShapeId: 'rect-1',
        endAnchor: 'center',
      });
      const point = getConnectorEndPoint(connector, shapes);
      expect(point.x).toBe(100);
      expect(point.y).toBe(100);
    });
  });

  describe('checkConnectorHealth', () => {
    it('reports healthy for floating endpoints', () => {
      const connector = createTestConnector();
      const health = checkConnectorHealth(connector, shapes);
      expect(health.isHealthy).toBe(true);
      expect(health.startStatus).toBe('floating');
      expect(health.endStatus).toBe('floating');
    });

    it('reports healthy for valid connections', () => {
      const connector = createTestConnector({
        startShapeId: 'rect-1',
        startAnchor: 'center',
        endShapeId: 'rect-1',
        endAnchor: 'right',
      });
      const health = checkConnectorHealth(connector, shapes);
      expect(health.isHealthy).toBe(true);
      expect(health.startStatus).toBe('connected');
      expect(health.endStatus).toBe('connected');
    });

    it('reports orphaned when shape not found', () => {
      const connector = createTestConnector({
        startShapeId: 'deleted-shape',
      });
      const health = checkConnectorHealth(connector, shapes);
      expect(health.isHealthy).toBe(false);
      expect(health.startStatus).toBe('orphaned');
      expect(health.issues).toContain('Start shape "deleted-shape" not found');
    });
  });

  describe('findOrphanedConnectors', () => {
    it('returns empty array when no orphans', () => {
      const connector = createTestConnector();
      const allShapes = { ...shapes, 'test-connector': connector };
      const orphans = findOrphanedConnectors(allShapes);
      expect(orphans).toHaveLength(0);
    });

    it('finds orphaned connectors', () => {
      const connector = createTestConnector({
        startShapeId: 'deleted-shape',
      });
      const allShapes = { ...shapes, 'test-connector': connector };
      const orphans = findOrphanedConnectors(allShapes);
      expect(orphans).toHaveLength(1);
      expect(orphans[0]?.connector.id).toBe('test-connector');
    });
  });

  describe('updateConnectorEndpoints', () => {
    it('updates start point when connected', () => {
      const connector = createTestConnector({
        startShapeId: 'rect-1',
        startAnchor: 'center',
        x: 0,
        y: 0,
      });
      const updates = updateConnectorEndpoints(connector, shapes);
      expect(updates.x).toBe(100);
      expect(updates.y).toBe(100);
    });

    it('updates end point when connected', () => {
      const connector = createTestConnector({
        endShapeId: 'rect-1',
        endAnchor: 'center',
        x2: 0,
        y2: 0,
      });
      const updates = updateConnectorEndpoints(connector, shapes);
      expect(updates.x2).toBe(100);
      expect(updates.y2).toBe(100);
    });

    it('returns empty updates when not connected', () => {
      const connector = createTestConnector();
      const updates = updateConnectorEndpoints(connector, shapes);
      expect(Object.keys(updates)).toHaveLength(0);
    });
  });

  describe('findClosestAnchor', () => {
    it('finds closest anchor point', () => {
      const result = findClosestAnchor(testRect, new Vec2(140, 100));
      expect(result).not.toBeNull();
      expect(result?.anchor.position).toBe('right');
    });

    it('respects maxDistance parameter', () => {
      const result = findClosestAnchor(testRect, new Vec2(500, 500), 10);
      expect(result).toBeNull();
    });
  });
});

describe('FlowType property', () => {
  it('object flow uses dashed line', () => {
    const ctx = createMockContext();
    const connector = createTestConnector({ flowType: 'object' });

    connectorHandler.render(ctx, connector);

    const setLineDashCalls = (ctx.setLineDash as ReturnType<typeof vi.fn>).mock.calls;
    expect(setLineDashCalls.some((call: unknown[]) =>
      Array.isArray(call[0]) && call[0].length > 0
    )).toBe(true);
  });

  it('control flow uses solid line', () => {
    const ctx = createMockContext();
    const connector = createTestConnector({ flowType: 'control', lineStyle: 'solid' });

    connectorHandler.render(ctx, connector);

    const setLineDashCalls = (ctx.setLineDash as ReturnType<typeof vi.fn>).mock.calls;
    // First call should be solid (empty array)
    expect(setLineDashCalls[0]).toEqual([[]]);
  });

  it('flowType object overrides lineStyle solid', () => {
    const ctx = createMockContext();
    const connector = createTestConnector({
      flowType: 'object',
      lineStyle: 'solid',  // Should be overridden by flowType
    });

    connectorHandler.render(ctx, connector);

    const setLineDashCalls = (ctx.setLineDash as ReturnType<typeof vi.fn>).mock.calls;
    // First call should be dashed (object flow overrides)
    expect(setLineDashCalls[0]).toEqual([[8, 4]]);
  });
});

describe('resolveArrowStyle', () => {
  it('returns the explicit style when set, ignoring the legacy boolean', () => {
    const shape = { startArrow: true, endArrow: true, startArrowStyle: 'diamond' as const };
    expect(resolveArrowStyle(shape, 'start')).toBe('diamond');
  });

  it('maps legacy startArrow=true to "triangle" when no style is set', () => {
    expect(resolveArrowStyle({ startArrow: true, endArrow: false }, 'start')).toBe('triangle');
  });

  it('maps legacy startArrow=false to "none" when no style is set', () => {
    expect(resolveArrowStyle({ startArrow: false, endArrow: true }, 'start')).toBe('none');
  });

  it('resolves each endpoint independently', () => {
    const shape = {
      startArrow: true,
      endArrow: false,
      endArrowStyle: 'open' as const,
    };
    expect(resolveArrowStyle(shape, 'start')).toBe('triangle');
    expect(resolveArrowStyle(shape, 'end')).toBe('open');
  });

  it('treats an explicit "none" style as authoritative over a legacy true boolean', () => {
    const shape = {
      startArrow: true,
      endArrow: true,
      endArrowStyle: 'none' as const,
    };
    expect(resolveArrowStyle(shape, 'end')).toBe('none');
  });
});

describe('endpoint boundary clipping', () => {
  // Rectangle x,y is the centre; a 100×100 box at (0,0) spans [-50,50]².
  function box(overrides: Partial<RectangleShape> & { id: string }): RectangleShape {
    return {
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      fill: '#fff',
      stroke: '#000',
      // strokeWidth 0 so getBounds has no stroke padding — the box is exactly
      // [-50,50]², keeping the clip assertions on round numbers.
      strokeWidth: 0,
      cornerRadius: 0,
      ...overrides,
    };
  }

  describe('clipPointToShapeBoundary', () => {
    it('clips a centre point to the edge facing the target', () => {
      const shape = box({ id: 'r' });
      expect(clipPointToShapeBoundary(new Vec2(0, 0), new Vec2(200, 0), shape)).toEqual(
        new Vec2(50, 0)
      );
      expect(clipPointToShapeBoundary(new Vec2(0, 0), new Vec2(0, -200), shape)).toEqual(
        new Vec2(0, -50)
      );
    });

    it('leaves a point already on the boundary unchanged (same reference)', () => {
      const shape = box({ id: 'r' });
      const edge = new Vec2(50, 0); // right-edge anchor, not strictly inside
      expect(clipPointToShapeBoundary(edge, new Vec2(200, 0), shape)).toBe(edge);
    });

    it('leaves a point outside the shape unchanged', () => {
      const shape = box({ id: 'r' });
      const outside = new Vec2(300, 0);
      expect(clipPointToShapeBoundary(outside, new Vec2(0, 0), shape)).toBe(outside);
    });

    it('refines onto a non-rectangular outline (ellipse) instead of the box corner (JP-302)', () => {
      // A radius-50 circle. A diagonal approach exits the bounding box at the
      // corner (~70.7 from centre); the true circle edge is at radius 50.
      const circle: Shape = {
        id: 'circle',
        type: 'ellipse',
        x: 0,
        y: 0,
        radiusX: 50,
        radiusY: 50,
        rotation: 0,
        opacity: 1,
        locked: false,
        visible: true,
        fill: '#ffffff',
        stroke: '#000000',
        strokeWidth: 0, // no stroke band → exact fill edge
      } as Shape;

      const clipped = clipPointToShapeBoundary(new Vec2(0, 0), new Vec2(200, 200), circle);
      const dist = Math.hypot(clipped.x, clipped.y);
      expect(dist).toBeGreaterThan(45); // on the circle, not the centre
      expect(dist).toBeLessThan(60); // NOT the box corner (~70.7)
      expect(Math.abs(clipped.x - clipped.y)).toBeLessThan(1); // symmetric at 45°
    });
  });

  describe('clipConnectorEndpoints', () => {
    it('clips a bound start endpoint to the shape edge', () => {
      const shapes: Record<string, Shape> = { r: box({ id: 'r' }) };
      const connector = createTestConnector({ startShapeId: 'r', x: 0, y: 0, x2: 200, y2: 0 });
      const points = [new Vec2(0, 0), new Vec2(200, 0)];

      const result = clipConnectorEndpoints(points, connector, shapes);

      expect(result[0]).toEqual(new Vec2(50, 0)); // clipped to right edge
      expect(result[1]).toEqual(new Vec2(200, 0)); // unbound end untouched
    });

    it('returns the same array reference when nothing is bound', () => {
      const connector = createTestConnector({ startShapeId: null, endShapeId: null });
      const points = [new Vec2(0, 0), new Vec2(200, 0)];
      expect(clipConnectorEndpoints(points, connector, {})).toBe(points);
    });
  });
});

describe('curved routing mode', () => {
  it('renders a dense smooth path through the waypoints', () => {
    const ctx = createMockContext();
    connectorHandler.render(
      ctx,
      createTestConnector({
        routingMode: 'curved',
        stroke: '#000000',
        x: 0,
        y: 0,
        x2: 200,
        y2: 0,
        waypoints: [{ x: 100, y: 80 }],
      })
    );
    const lineToCalls = (ctx.lineTo as ReturnType<typeof vi.fn>).mock.calls;
    // Many short segments (vs a single segment for a straight 2-point line).
    expect(lineToCalls.length).toBeGreaterThan(10);
    // Catmull-Rom interpolates its control points → the curve passes exactly
    // through the waypoint.
    expect(lineToCalls).toContainEqual([100, 80]);
  });

  it('stays straight when there are no waypoints (nothing to smooth)', () => {
    const ctx = createMockContext();
    connectorHandler.render(
      ctx,
      createTestConnector({
        routingMode: 'curved',
        stroke: '#000000',
        x: 0,
        y: 0,
        x2: 200,
        y2: 0,
        startArrowStyle: 'none',
        endArrowStyle: 'none', // isolate the body line from arrowhead lineTo calls
      })
    );
    expect((ctx.lineTo as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

describe('label outline (labelStrokeColor)', () => {
  it('strokes the label text only when an outline colour is set', () => {
    const withOutline = createMockContext();
    connectorHandler.render(withOutline, createTestConnector({ label: 'Hi', labelStrokeColor: '#ffffff' }));
    expect(withOutline.strokeText).toHaveBeenCalled();

    const without = createMockContext();
    connectorHandler.render(without, createTestConnector({ label: 'Hi' }));
    expect(without.strokeText).not.toHaveBeenCalled();
  });
});

describe('arrowhead contrast colour (JP-137)', () => {
  function recordingContext(): { ctx: CanvasRenderingContext2D; colors: string[] } {
    const ctx = createMockContext();
    const colors: string[] = [];
    let fill = '';
    let strokeColor = '';
    Object.defineProperty(ctx, 'fillStyle', {
      get: () => fill,
      set: (v: string) => {
        fill = v;
        colors.push(v);
      },
      configurable: true,
    });
    Object.defineProperty(ctx, 'strokeStyle', {
      get: () => strokeColor,
      set: (v: string) => {
        strokeColor = v;
        colors.push(v);
      },
      configurable: true,
    });
    return { ctx, colors };
  }

  it('keeps the arrowhead uniform with the line instead of resolving on the hitched shape', () => {
    const lightShape: RectangleShape = {
      id: 'light',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      fill: '#ffffff',
      stroke: '#ffffff',
      strokeWidth: 0,
      cornerRadius: 0,
    };

    setRenderContext({
      shapes: { light: lightShape },
      shapeOrder: ['light'],
      pageBackground: '#101020', // dark
      contrastCache: new ContrastCache(),
    });
    try {
      const connector = createTestConnector({
        stroke: 'auto',
        startShapeId: 'light',
        x: 0,
        y: 0,
        x2: 500,
        y2: 0,
        startArrowStyle: 'triangle',
        endArrowStyle: 'triangle',
      });

      const { ctx, colors } = recordingContext();
      connectorHandler.render(ctx, connector);

      expect(colors).toContain('#ffffff'); // body + heads resolve to the dark-bg contrast
      expect(colors).not.toContain('#000000'); // no black tip from the light hitched shape
    } finally {
      setRenderContext(null);
    }
  });
});
