import { describe, it, expect, vi } from 'vitest';
import { ellipseHandler } from './Ellipse';
import { EllipseShape } from './Shape';
import { Vec2 } from '../math/Vec2';

/**
 * Create a test ellipse with default properties.
 */
function createTestEllipse(overrides: Partial<EllipseShape> = {}): EllipseShape {
  return {
    id: 'test-ellipse',
    type: 'ellipse',
    x: 0,
    y: 0,
    radiusX: 50,
    radiusY: 40,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#4a90d9',
    stroke: '#2c5282',
    strokeWidth: 2,
    ...overrides,
  };
}

describe('Ellipse Handler', () => {
  describe('hitTest', () => {
    it('returns true for point at center of ellipse', () => {
      const ellipse = createTestEllipse();

      expect(ellipseHandler.hitTest(ellipse, new Vec2(0, 0))).toBe(true);
    });

    it('returns true for point inside ellipse', () => {
      const ellipse = createTestEllipse();

      expect(ellipseHandler.hitTest(ellipse, new Vec2(30, 20))).toBe(true);
      expect(ellipseHandler.hitTest(ellipse, new Vec2(-30, -20))).toBe(true);
    });

    it('returns true for point on ellipse boundary', () => {
      const ellipse = createTestEllipse({ strokeWidth: 0 });

      // Point on X-axis at radius
      expect(ellipseHandler.hitTest(ellipse, new Vec2(50, 0))).toBe(true);
      // Point on Y-axis at radius
      expect(ellipseHandler.hitTest(ellipse, new Vec2(0, 40))).toBe(true);
    });

    it('returns false for point outside ellipse', () => {
      const ellipse = createTestEllipse({ strokeWidth: 0 });

      expect(ellipseHandler.hitTest(ellipse, new Vec2(60, 0))).toBe(false);
      expect(ellipseHandler.hitTest(ellipse, new Vec2(0, 50))).toBe(false);
      expect(ellipseHandler.hitTest(ellipse, new Vec2(100, 100))).toBe(false);
    });

    it('accounts for stroke width in hit area', () => {
      const ellipse = createTestEllipse({ strokeWidth: 10 });

      // Point at exact edge should be inside
      expect(ellipseHandler.hitTest(ellipse, new Vec2(50, 0))).toBe(true);
      // Point just outside ellipse but within stroke should be inside
      expect(ellipseHandler.hitTest(ellipse, new Vec2(53, 0))).toBe(true);
      // Point outside stroke area should be outside
      expect(ellipseHandler.hitTest(ellipse, new Vec2(58, 0))).toBe(false);
    });

    it('handles offset ellipses', () => {
      const ellipse = createTestEllipse({ x: 100, y: 50 });

      expect(ellipseHandler.hitTest(ellipse, new Vec2(100, 50))).toBe(true);
      expect(ellipseHandler.hitTest(ellipse, new Vec2(130, 70))).toBe(true);
      expect(ellipseHandler.hitTest(ellipse, new Vec2(0, 0))).toBe(false);
    });

    it('handles rotated ellipses', () => {
      // 90 degree rotation swaps X and Y radii effectively
      const ellipse = createTestEllipse({ rotation: Math.PI / 2 });

      // Center should be inside
      expect(ellipseHandler.hitTest(ellipse, new Vec2(0, 0))).toBe(true);
      // After 90 deg rotation, what was radiusX (50) is now vertical
      // and what was radiusY (40) is now horizontal
      expect(ellipseHandler.hitTest(ellipse, new Vec2(0, 48))).toBe(true);
      expect(ellipseHandler.hitTest(ellipse, new Vec2(38, 0))).toBe(true);
    });

    it('handles circle (equal radii)', () => {
      const circle = createTestEllipse({ radiusX: 50, radiusY: 50, strokeWidth: 0 });

      // All points at distance 40 should be inside
      expect(ellipseHandler.hitTest(circle, new Vec2(40, 0))).toBe(true);
      expect(ellipseHandler.hitTest(circle, new Vec2(0, 40))).toBe(true);
      expect(ellipseHandler.hitTest(circle, new Vec2(28.28, 28.28))).toBe(true);

      // Points at distance 60 should be outside
      expect(ellipseHandler.hitTest(circle, new Vec2(60, 0))).toBe(false);
    });
  });

  describe('getBounds', () => {
    it('returns correct bounds for unrotated ellipse', () => {
      const ellipse = createTestEllipse();
      const bounds = ellipseHandler.getBounds(ellipse);

      // radiusX 50, radiusY 40, centered at origin
      // Bounds: -50 to 50 on X, -40 to 40 on Y, plus stroke
      expect(bounds.minX).toBeCloseTo(-51); // -50 - 1 (half stroke)
      expect(bounds.minY).toBeCloseTo(-41);
      expect(bounds.maxX).toBeCloseTo(51);
      expect(bounds.maxY).toBeCloseTo(41);
    });

    it('returns correct bounds for offset ellipse', () => {
      const ellipse = createTestEllipse({ x: 100, y: 50 });
      const bounds = ellipseHandler.getBounds(ellipse);

      expect(bounds.minX).toBeCloseTo(49); // 100 - 50 - 1
      expect(bounds.minY).toBeCloseTo(9); // 50 - 40 - 1
      expect(bounds.maxX).toBeCloseTo(151); // 100 + 50 + 1
      expect(bounds.maxY).toBeCloseTo(91); // 50 + 40 + 1
    });

    it('returns expanded bounds for rotated ellipse', () => {
      // 90 degree rotation swaps the axes
      const ellipse = createTestEllipse({ rotation: Math.PI / 2 });
      const bounds = ellipseHandler.getBounds(ellipse);

      // After 90 deg rotation, radiusX (50) becomes vertical extent
      // and radiusY (40) becomes horizontal extent
      expect(bounds.minX).toBeCloseTo(-41, 0); // -40 - 1
      expect(bounds.maxX).toBeCloseTo(41, 0);
      expect(bounds.minY).toBeCloseTo(-51, 0); // -50 - 1
      expect(bounds.maxY).toBeCloseTo(51, 0);
    });

    it('handles circle correctly', () => {
      const circle = createTestEllipse({ radiusX: 50, radiusY: 50 });
      const bounds = ellipseHandler.getBounds(circle);

      expect(bounds.minX).toBeCloseTo(-51);
      expect(bounds.minY).toBeCloseTo(-51);
      expect(bounds.maxX).toBeCloseTo(51);
      expect(bounds.maxY).toBeCloseTo(51);
    });

    it('includes stroke width in bounds', () => {
      const ellipse = createTestEllipse({ strokeWidth: 20 });
      const bounds = ellipseHandler.getBounds(ellipse);

      // Half stroke = 10
      expect(bounds.minX).toBeCloseTo(-60); // -50 - 10
      expect(bounds.maxX).toBeCloseTo(60);
    });
  });

  describe('getHandles', () => {
    it('returns 9 handles for ellipse (8 resize + 1 rotation)', () => {
      const ellipse = createTestEllipse();
      const handles = ellipseHandler.getHandles(ellipse);

      expect(handles).toHaveLength(9);
    });

    it('returns handles at correct positions for unrotated ellipse', () => {
      const ellipse = createTestEllipse();
      const handles = ellipseHandler.getHandles(ellipse);

      const byType = new Map(handles.map((h) => [h.type, h]));

      // Axis handles
      expect(byType.get('top')?.x).toBeCloseTo(0);
      expect(byType.get('top')?.y).toBeCloseTo(-40);
      expect(byType.get('right')?.x).toBeCloseTo(50);
      expect(byType.get('right')?.y).toBeCloseTo(0);
      expect(byType.get('bottom')?.x).toBeCloseTo(0);
      expect(byType.get('bottom')?.y).toBeCloseTo(40);
      expect(byType.get('left')?.x).toBeCloseTo(-50);
      expect(byType.get('left')?.y).toBeCloseTo(0);
    });

    it('returns diagonal handles at 45 degree positions', () => {
      const ellipse = createTestEllipse();
      const handles = ellipseHandler.getHandles(ellipse);

      const byType = new Map(handles.map((h) => [h.type, h]));

      // Diagonal handles at sqrt(2)/2 * radius
      const diagX = 50 * Math.SQRT1_2;
      const diagY = 40 * Math.SQRT1_2;

      expect(byType.get('top-left')?.x).toBeCloseTo(-diagX);
      expect(byType.get('top-left')?.y).toBeCloseTo(-diagY);
      expect(byType.get('bottom-right')?.x).toBeCloseTo(diagX);
      expect(byType.get('bottom-right')?.y).toBeCloseTo(diagY);
    });

    it('transforms handles for offset ellipse', () => {
      const ellipse = createTestEllipse({ x: 100, y: 50 });
      const handles = ellipseHandler.getHandles(ellipse);

      const top = handles.find((h) => h.type === 'top')!;
      expect(top.x).toBeCloseTo(100);
      expect(top.y).toBeCloseTo(10); // 50 - 40
    });

    it('transforms handles for rotated ellipse', () => {
      const ellipse = createTestEllipse({ rotation: Math.PI / 2 }); // 90 degrees
      const handles = ellipseHandler.getHandles(ellipse);

      const top = handles.find((h) => h.type === 'top')!;
      // Top was at (0, -40), after 90 deg rotation becomes (40, 0)
      expect(top.x).toBeCloseTo(40);
      expect(top.y).toBeCloseTo(0);
    });

    it('includes cursor styles', () => {
      const ellipse = createTestEllipse();
      const handles = ellipseHandler.getHandles(ellipse);

      const topLeft = handles.find((h) => h.type === 'top-left')!;
      expect(topLeft.cursor).toBe('nwse-resize');

      const top = handles.find((h) => h.type === 'top')!;
      expect(top.cursor).toBe('ns-resize');
    });
  });

  describe('create', () => {
    it('creates ellipse at given position', () => {
      const ellipse = ellipseHandler.create(new Vec2(100, 50), 'new-ellipse');

      expect(ellipse.id).toBe('new-ellipse');
      expect(ellipse.type).toBe('ellipse');
      expect(ellipse.x).toBe(100);
      expect(ellipse.y).toBe(50);
    });

    it('uses default values', () => {
      const ellipse = ellipseHandler.create(new Vec2(0, 0), 'test');

      expect(ellipse.radiusX).toBe(50);
      expect(ellipse.radiusY).toBe(40);
      expect(ellipse.rotation).toBe(0);
      expect(ellipse.opacity).toBe(1);
      expect(ellipse.locked).toBe(false);
      expect(ellipse.fill).toBe('#4a90d9');
      expect(ellipse.stroke).toBe('#2c5282');
      expect(ellipse.strokeWidth).toBe(2);
    });
  });

  describe('render', () => {
    // The handler is now generated by the declarative factory, which draws via
    // a Path2D (ctx.fill(path)/ctx.stroke(path)) rather than ctx.ellipse.
    function makeRenderCtx() {
      return {
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        fillText: vi.fn(),
        measureText: () => ({ width: 0 }) as TextMetrics,
        globalAlpha: 1,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        textAlign: '',
        textBaseline: '',
      } as unknown as CanvasRenderingContext2D;
    }

    it('fills and strokes within a save/restore + camera transform', () => {
      const ctx = makeRenderCtx();
      ellipseHandler.render(ctx, createTestEllipse());
      expect(ctx.save).toHaveBeenCalled();
      expect(ctx.translate).toHaveBeenCalledWith(0, 0);
      expect(ctx.rotate).toHaveBeenCalledWith(0);
      expect(ctx.fill).toHaveBeenCalled();
      expect(ctx.stroke).toHaveBeenCalled();
      expect(ctx.restore).toHaveBeenCalled();
    });

    it('does not fill when fill is null', () => {
      const ctx = makeRenderCtx();
      ellipseHandler.render(ctx, createTestEllipse({ fill: null }));
      expect(ctx.fill).not.toHaveBeenCalled();
      expect(ctx.stroke).toHaveBeenCalled();
    });

    it('does not stroke when stroke is null', () => {
      const ctx = makeRenderCtx();
      ellipseHandler.render(ctx, createTestEllipse({ stroke: null }));
      expect(ctx.fill).toHaveBeenCalled();
      expect(ctx.stroke).not.toHaveBeenCalled();
    });

    it('applies opacity', () => {
      const ctx = makeRenderCtx();
      ellipseHandler.render(ctx, createTestEllipse({ opacity: 0.5 }));
      expect(ctx.globalAlpha).toBe(0.5);
    });
  });
});
