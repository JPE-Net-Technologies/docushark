import { describe, it, expect, vi } from 'vitest';
import { rectangleHandler } from './Rectangle';
import { RectangleShape } from './Shape';
import { Vec2 } from '../math/Vec2';

/**
 * Create a test rectangle with default properties.
 */
function createTestRect(overrides: Partial<RectangleShape> = {}): RectangleShape {
  return {
    id: 'test-rect',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#4a90d9',
    stroke: '#2c5282',
    strokeWidth: 2,
    cornerRadius: 0,
    ...overrides,
  };
}

describe('Rectangle Handler', () => {
  describe('hitTest', () => {
    it('returns true for point inside rectangle', () => {
      const rect = createTestRect();

      expect(rectangleHandler.hitTest(rect, new Vec2(0, 0))).toBe(true);
      expect(rectangleHandler.hitTest(rect, new Vec2(40, 30))).toBe(true);
      expect(rectangleHandler.hitTest(rect, new Vec2(-40, -30))).toBe(true);
    });

    it('returns false for point outside rectangle', () => {
      const rect = createTestRect();

      expect(rectangleHandler.hitTest(rect, new Vec2(60, 0))).toBe(false);
      expect(rectangleHandler.hitTest(rect, new Vec2(0, 50))).toBe(false);
      expect(rectangleHandler.hitTest(rect, new Vec2(100, 100))).toBe(false);
    });

    it('accounts for stroke width in hit area', () => {
      const rect = createTestRect({ strokeWidth: 10 });

      // Point at exact edge should be inside
      expect(rectangleHandler.hitTest(rect, new Vec2(50, 0))).toBe(true);
      // Point just outside rect but within stroke should be inside
      expect(rectangleHandler.hitTest(rect, new Vec2(53, 0))).toBe(true);
      // Point outside stroke area should be outside
      expect(rectangleHandler.hitTest(rect, new Vec2(58, 0))).toBe(false);
    });

    it('handles offset rectangles', () => {
      const rect = createTestRect({ x: 100, y: 50 });

      expect(rectangleHandler.hitTest(rect, new Vec2(100, 50))).toBe(true);
      expect(rectangleHandler.hitTest(rect, new Vec2(140, 80))).toBe(true);
      expect(rectangleHandler.hitTest(rect, new Vec2(0, 0))).toBe(false);
    });

    it('handles rotated rectangles', () => {
      // 90 degree rotation
      const rect = createTestRect({ rotation: Math.PI / 2 });

      // After 90 deg rotation, what was horizontal is now vertical
      // Point that was inside is still inside
      expect(rectangleHandler.hitTest(rect, new Vec2(0, 0))).toBe(true);
      // Point along original X-axis (now Y-axis) should be inside
      expect(rectangleHandler.hitTest(rect, new Vec2(0, 40))).toBe(true);
      // Point along original Y-axis (now X-axis) should be inside
      expect(rectangleHandler.hitTest(rect, new Vec2(30, 0))).toBe(true);
    });

    it('handles 45 degree rotation', () => {
      const rect = createTestRect({ width: 100, height: 100, rotation: Math.PI / 4 });

      // Center should be inside
      expect(rectangleHandler.hitTest(rect, new Vec2(0, 0))).toBe(true);
      // Corner of rotated square should still be inside
      // After 45deg rotation of 50x50 half-extents, corners are at ~70.7 from center
      expect(rectangleHandler.hitTest(rect, new Vec2(50, 0))).toBe(true);
      expect(rectangleHandler.hitTest(rect, new Vec2(0, 50))).toBe(true);
    });
  });

  describe('getBounds', () => {
    it('returns correct bounds for unrotated rectangle', () => {
      const rect = createTestRect();
      const bounds = rectangleHandler.getBounds(rect);

      // Width 100, height 80, centered at origin
      // Bounds: -50 to 50 on X, -40 to 40 on Y, plus stroke
      expect(bounds.minX).toBeCloseTo(-51); // -50 - 1 (half stroke)
      expect(bounds.minY).toBeCloseTo(-41);
      expect(bounds.maxX).toBeCloseTo(51);
      expect(bounds.maxY).toBeCloseTo(41);
    });

    it('returns correct bounds for offset rectangle', () => {
      const rect = createTestRect({ x: 100, y: 50 });
      const bounds = rectangleHandler.getBounds(rect);

      expect(bounds.minX).toBeCloseTo(49); // 100 - 50 - 1
      expect(bounds.minY).toBeCloseTo(9); // 50 - 40 - 1
      expect(bounds.maxX).toBeCloseTo(151); // 100 + 50 + 1
      expect(bounds.maxY).toBeCloseTo(91); // 50 + 40 + 1
    });

    it('returns expanded bounds for rotated rectangle', () => {
      // 45 degree rotation expands the AABB
      const rect = createTestRect({ width: 100, height: 100, rotation: Math.PI / 4 });
      const bounds = rectangleHandler.getBounds(rect);

      // A 100x100 square rotated 45 degrees has diagonal ~141.4
      // Half-diagonal ~70.7, plus stroke of 1
      const expected = 70.71 + 1;
      expect(bounds.minX).toBeCloseTo(-expected, 0);
      expect(bounds.maxX).toBeCloseTo(expected, 0);
    });

    it('includes stroke width in bounds', () => {
      const rect = createTestRect({ strokeWidth: 20 });
      const bounds = rectangleHandler.getBounds(rect);

      // Half stroke = 10
      expect(bounds.minX).toBeCloseTo(-60); // -50 - 10
      expect(bounds.maxX).toBeCloseTo(60);
    });
  });

  describe('getHandles', () => {
    it('returns 9 handles for unrotated rectangle (8 resize + 1 rotation)', () => {
      const rect = createTestRect();
      const handles = rectangleHandler.getHandles(rect);

      expect(handles).toHaveLength(9);
    });

    it('returns handles at correct positions', () => {
      const rect = createTestRect();
      const handles = rectangleHandler.getHandles(rect);

      const byType = new Map(handles.map((h) => [h.type, h]));

      // Corner handles
      expect(byType.get('top-left')?.x).toBeCloseTo(-50);
      expect(byType.get('top-left')?.y).toBeCloseTo(-40);
      expect(byType.get('bottom-right')?.x).toBeCloseTo(50);
      expect(byType.get('bottom-right')?.y).toBeCloseTo(40);

      // Edge midpoint handles
      expect(byType.get('top')?.x).toBeCloseTo(0);
      expect(byType.get('top')?.y).toBeCloseTo(-40);
      expect(byType.get('right')?.x).toBeCloseTo(50);
      expect(byType.get('right')?.y).toBeCloseTo(0);
    });

    it('transforms handles for offset rectangle', () => {
      const rect = createTestRect({ x: 100, y: 50 });
      const handles = rectangleHandler.getHandles(rect);

      const topLeft = handles.find((h) => h.type === 'top-left')!;
      expect(topLeft.x).toBeCloseTo(50); // 100 - 50
      expect(topLeft.y).toBeCloseTo(10); // 50 - 40
    });

    it('transforms handles for rotated rectangle', () => {
      const rect = createTestRect({ rotation: Math.PI / 2 }); // 90 degrees
      const handles = rectangleHandler.getHandles(rect);

      const topLeft = handles.find((h) => h.type === 'top-left')!;
      // Top-left was at (-50, -40), after 90 deg rotation becomes (40, -50)
      expect(topLeft.x).toBeCloseTo(40);
      expect(topLeft.y).toBeCloseTo(-50);
    });

    it('includes cursor styles', () => {
      const rect = createTestRect();
      const handles = rectangleHandler.getHandles(rect);

      const topLeft = handles.find((h) => h.type === 'top-left')!;
      expect(topLeft.cursor).toBe('nwse-resize');

      const top = handles.find((h) => h.type === 'top')!;
      expect(top.cursor).toBe('ns-resize');
    });
  });

  describe('create', () => {
    it('creates rectangle at given position', () => {
      const rect = rectangleHandler.create(new Vec2(100, 50), 'new-rect');

      expect(rect.id).toBe('new-rect');
      expect(rect.type).toBe('rectangle');
      expect(rect.x).toBe(100);
      expect(rect.y).toBe(50);
    });

    it('uses default values', () => {
      const rect = rectangleHandler.create(new Vec2(0, 0), 'test');

      expect(rect.width).toBe(100);
      expect(rect.height).toBe(80);
      expect(rect.rotation).toBe(0);
      expect(rect.opacity).toBe(1);
      expect(rect.locked).toBe(false);
      expect(rect.fill).toBe('#4a90d9');
      expect(rect.stroke).toBe('#2c5282');
      expect(rect.strokeWidth).toBe(2);
      expect(rect.cornerRadius).toBe(0);
    });
  });

  describe('render', () => {
    // The handler is now generated by the declarative factory, which draws via
    // a Path2D (ctx.fill(path)/ctx.stroke(path)) rather than ctx.rect/arcTo.
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
      rectangleHandler.render(ctx, createTestRect());

      expect(ctx.save).toHaveBeenCalled();
      expect(ctx.translate).toHaveBeenCalledWith(0, 0);
      expect(ctx.rotate).toHaveBeenCalledWith(0);
      expect(ctx.fill).toHaveBeenCalled();
      expect(ctx.stroke).toHaveBeenCalled();
      expect(ctx.restore).toHaveBeenCalled();
    });

    it('does not fill when fill is null', () => {
      const ctx = makeRenderCtx();
      rectangleHandler.render(ctx, createTestRect({ fill: null }));
      expect(ctx.fill).not.toHaveBeenCalled();
      expect(ctx.stroke).toHaveBeenCalled();
    });

    it('does not stroke when stroke is null', () => {
      const ctx = makeRenderCtx();
      rectangleHandler.render(ctx, createTestRect({ stroke: null }));
      expect(ctx.fill).toHaveBeenCalled();
      expect(ctx.stroke).not.toHaveBeenCalled();
    });

    it('renders rounded corners without error', () => {
      const ctx = makeRenderCtx();
      rectangleHandler.render(ctx, createTestRect({ cornerRadius: 10 }));
      expect(ctx.fill).toHaveBeenCalled();
      expect(ctx.stroke).toHaveBeenCalled();
    });
  });
});
