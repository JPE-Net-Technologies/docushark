import { describe, it, expect } from 'vitest';
import { Vec2 } from '../../math/Vec2';
import {
  RectangleShape,
  EllipseShape,
  LineShape,
  Shape,
  TextShape,
} from '../Shape';
import {
  translateShape,
  translateShapes,
  rotateShape,
  rotateShapeBy,
  rotateShapeAround,
  resizeShape,
  setShapeSize,
  setShapePosition,
  cloneShape,
  cloneShapeWithOffset,
} from './transforms';

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

/**
 * Create a test line with default properties.
 */
function createTestLine(overrides: Partial<LineShape> = {}): LineShape {
  return {
    id: 'test-line',
    type: 'line',
    x: 0,
    y: 0,
    x2: 100,
    y2: 50,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: null,
    stroke: '#2c5282',
    strokeWidth: 2,
    startArrow: false,
    endArrow: true,
    ...overrides,
  };
}

/**
 * Create a test text shape with default properties.
 */
function createTestText(overrides: Partial<TextShape> = {}): TextShape {
  return {
    id: 'test-text',
    type: 'text',
    x: 0,
    y: 0,
    text: 'Hello World',
    fontSize: 16,
    fontFamily: 'sans-serif',
    textAlign: 'left',
    verticalAlign: 'top',
    width: 200,
    height: 50,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#000000',
    stroke: null,
    strokeWidth: 0,
    ...overrides,
  };
}

describe('Transform Utilities', () => {
  describe('translateShape', () => {
    it('translates rectangle position', () => {
      const rect = createTestRect({ x: 10, y: 20 });
      const translated = translateShape(rect, new Vec2(30, 40));

      expect(translated.x).toBe(40);
      expect(translated.y).toBe(60);
      expect(translated.width).toBe(100); // Unchanged
    });

    it('translates line with both endpoints', () => {
      const line = createTestLine({ x: 0, y: 0, x2: 100, y2: 50 });
      const translated = translateShape(line, new Vec2(10, 20));

      expect(translated.x).toBe(10);
      expect(translated.y).toBe(20);
      expect(translated.x2).toBe(110);
      expect(translated.y2).toBe(70);
    });

    it("translates a connector's second endpoint and waypoints too", () => {
      const connector = {
        ...createTestLine({ x: 0, y: 0, x2: 100, y2: 0 }),
        type: 'connector',
        waypoints: [{ x: 50, y: 50 }],
      } as unknown as Shape & { x2: number; y2: number; waypoints: Array<{ x: number; y: number }> };
      const translated = translateShape(connector, new Vec2(10, 20));

      expect([translated.x, translated.y, translated.x2, translated.y2]).toEqual([10, 20, 110, 20]);
      expect(translated.waypoints).toEqual([{ x: 60, y: 70 }]);
      expect(connector.waypoints).toEqual([{ x: 50, y: 50 }]); // not mutated
    });

    it('does not mutate original shape', () => {
      const rect = createTestRect({ x: 10, y: 20 });
      translateShape(rect, new Vec2(30, 40));

      expect(rect.x).toBe(10);
      expect(rect.y).toBe(20);
    });

    it('handles negative deltas', () => {
      const rect = createTestRect({ x: 50, y: 50 });
      const translated = translateShape(rect, new Vec2(-30, -20));

      expect(translated.x).toBe(20);
      expect(translated.y).toBe(30);
    });
  });

  describe('translateShapes', () => {
    it('translates multiple shapes', () => {
      const shapes = [
        createTestRect({ id: 'rect1', x: 0, y: 0 }),
        createTestRect({ id: 'rect2', x: 100, y: 100 }),
      ];
      const translated = translateShapes(shapes, new Vec2(10, 20));

      expect(translated[0]!.x).toBe(10);
      expect(translated[0]!.y).toBe(20);
      expect(translated[1]!.x).toBe(110);
      expect(translated[1]!.y).toBe(120);
    });

    it('returns empty array for empty input', () => {
      const result = translateShapes([], new Vec2(10, 20));
      expect(result).toEqual([]);
    });
  });

  describe('rotateShape', () => {
    it('sets rotation to specified value', () => {
      const rect = createTestRect({ rotation: 0 });
      const rotated = rotateShape(rect, Math.PI / 4);

      expect(rotated.rotation).toBe(Math.PI / 4);
    });

    it('replaces existing rotation', () => {
      const rect = createTestRect({ rotation: Math.PI / 2 });
      const rotated = rotateShape(rect, Math.PI / 4);

      expect(rotated.rotation).toBe(Math.PI / 4);
    });
  });

  describe('rotateShapeBy', () => {
    it('adds to existing rotation', () => {
      const rect = createTestRect({ rotation: Math.PI / 4 });
      const rotated = rotateShapeBy(rect, Math.PI / 4);

      expect(rotated.rotation).toBeCloseTo(Math.PI / 2);
    });

    it('handles negative rotation', () => {
      const rect = createTestRect({ rotation: Math.PI });
      const rotated = rotateShapeBy(rect, -Math.PI / 2);

      expect(rotated.rotation).toBeCloseTo(Math.PI / 2);
    });
  });

  describe('rotateShapeAround', () => {
    it('rotates position around pivot', () => {
      const rect = createTestRect({ x: 100, y: 0 });
      const pivot = new Vec2(0, 0);
      const rotated = rotateShapeAround(rect, Math.PI / 2, pivot);

      expect(rotated.x).toBeCloseTo(0);
      expect(rotated.y).toBeCloseTo(100);
      expect(rotated.rotation).toBeCloseTo(Math.PI / 2);
    });

    it('updates line endpoints', () => {
      const line = createTestLine({ x: 100, y: 0, x2: 200, y2: 0 });
      const pivot = new Vec2(0, 0);
      const rotated = rotateShapeAround(line, Math.PI / 2, pivot);

      expect(rotated.x).toBeCloseTo(0);
      expect(rotated.y).toBeCloseTo(100);
      expect(rotated.x2).toBeCloseTo(0);
      expect(rotated.y2).toBeCloseTo(200);
    });

    it('no position change when rotating around shape center', () => {
      const rect = createTestRect({ x: 100, y: 100 });
      const pivot = new Vec2(100, 100);
      const rotated = rotateShapeAround(rect, Math.PI / 4, pivot);

      expect(rotated.x).toBeCloseTo(100);
      expect(rotated.y).toBeCloseTo(100);
      expect(rotated.rotation).toBeCloseTo(Math.PI / 4);
    });
  });

  describe('resizeShape', () => {
    it('scales rectangle dimensions', () => {
      const rect = createTestRect({ width: 100, height: 80 });
      const resized = resizeShape(rect, { scaleX: 2, scaleY: 1.5 });

      expect(resized.width).toBe(200);
      expect(resized.height).toBe(120);
    });

    it('scales ellipse radii', () => {
      const ellipse = createTestEllipse({ radiusX: 50, radiusY: 40 });
      const resized = resizeShape(ellipse, { scaleX: 2, scaleY: 0.5 });

      expect(resized.radiusX).toBe(100);
      expect(resized.radiusY).toBe(20);
    });

    it('scales line endpoints relative to start', () => {
      const line = createTestLine({ x: 0, y: 0, x2: 100, y2: 50 });
      const resized = resizeShape(line, { scaleX: 2, scaleY: 2 });

      expect(resized.x).toBe(0);
      expect(resized.y).toBe(0);
      expect(resized.x2).toBe(200);
      expect(resized.y2).toBe(100);
    });

    it('scales text width and font size', () => {
      const text = createTestText({ width: 200, fontSize: 16 });
      const resized = resizeShape(text, { scaleX: 1.5, scaleY: 2 });

      expect(resized.width).toBe(300);
      expect(resized.fontSize).toBe(32); // Uses max(scaleX, scaleY)
    });

    it('handles negative scales (flip)', () => {
      const rect = createTestRect({ width: 100, height: 80 });
      const resized = resizeShape(rect, { scaleX: -1, scaleY: 1 });

      expect(resized.width).toBe(100); // Absolute value
    });

    it('scales relative to anchor point', () => {
      const rect = createTestRect({ x: 100, y: 100, width: 100, height: 100 });
      const anchor = new Vec2(0, 0);
      const resized = resizeShape(rect, { scaleX: 2, scaleY: 2, anchor });

      expect(resized.x).toBe(200);
      expect(resized.y).toBe(200);
      expect(resized.width).toBe(200);
    });

    it('maintains aspect ratio when requested', () => {
      const rect = createTestRect({ width: 100, height: 50 });
      const resized = resizeShape(rect, {
        scaleX: 2,
        scaleY: 1.5,
        maintainAspectRatio: true,
      });

      // Should use max scale (2) for both
      expect(resized.width).toBe(200);
      expect(resized.height).toBe(100);
    });
  });

  describe('setShapeSize', () => {
    it('sets rectangle dimensions', () => {
      const rect = createTestRect({ width: 100, height: 80 });
      const resized = setShapeSize(rect, 200, 150);

      expect(resized.width).toBe(200);
      expect(resized.height).toBe(150);
    });

    it('sets ellipse radii', () => {
      const ellipse = createTestEllipse({ radiusX: 50, radiusY: 40 });
      const resized = setShapeSize(ellipse, 100, 75);

      expect(resized.radiusX).toBe(100);
      expect(resized.radiusY).toBe(75);
    });

    it('sets line end point relative to start', () => {
      const line = createTestLine({ x: 10, y: 20, x2: 100, y2: 50 });
      const resized = setShapeSize(line, 200, 100);

      expect(resized.x).toBe(10);
      expect(resized.y).toBe(20);
      expect(resized.x2).toBe(210);
      expect(resized.y2).toBe(120);
    });

    it('sets text width only', () => {
      const text = createTestText({ width: 200 });
      const resized = setShapeSize(text, 300, 100);

      expect(resized.width).toBe(300);
    });

    it('handles negative values (uses absolute)', () => {
      const rect = createTestRect();
      const resized = setShapeSize(rect, -100, -50);

      expect(resized.width).toBe(100);
      expect(resized.height).toBe(50);
    });
  });

  describe('setShapePosition', () => {
    it('moves rectangle to position', () => {
      const rect = createTestRect({ x: 10, y: 20 });
      const moved = setShapePosition(rect, new Vec2(100, 200));

      expect(moved.x).toBe(100);
      expect(moved.y).toBe(200);
    });

    it('maintains line relative offset', () => {
      const line = createTestLine({ x: 0, y: 0, x2: 100, y2: 50 });
      const moved = setShapePosition(line, new Vec2(50, 50));

      expect(moved.x).toBe(50);
      expect(moved.y).toBe(50);
      expect(moved.x2).toBe(150);
      expect(moved.y2).toBe(100);
    });
  });

  describe('cloneShape', () => {
    it('creates copy with new ID', () => {
      const rect = createTestRect({ id: 'original', x: 100, y: 200 });
      const cloned = cloneShape(rect, 'clone');

      expect(cloned.id).toBe('clone');
      expect(cloned.x).toBe(100);
      expect(cloned.y).toBe(200);
      expect(cloned).not.toBe(rect);
    });

    it('preserves all properties', () => {
      const rect = createTestRect({
        fill: '#ff0000',
        stroke: '#00ff00',
        rotation: Math.PI / 4,
        opacity: 0.5,
      });
      const cloned = cloneShape(rect, 'clone');

      expect(cloned.fill).toBe('#ff0000');
      expect(cloned.stroke).toBe('#00ff00');
      expect(cloned.rotation).toBe(Math.PI / 4);
      expect(cloned.opacity).toBe(0.5);
    });
  });

  describe('cloneShapeWithOffset', () => {
    it('creates copy with offset position', () => {
      const rect = createTestRect({ id: 'original', x: 100, y: 200 });
      const cloned = cloneShapeWithOffset(rect, 'clone', new Vec2(50, 50));

      expect(cloned.id).toBe('clone');
      expect(cloned.x).toBe(150);
      expect(cloned.y).toBe(250);
    });

    it('offsets line endpoints', () => {
      const line = createTestLine({ x: 0, y: 0, x2: 100, y2: 50 });
      const cloned = cloneShapeWithOffset(line, 'clone', new Vec2(10, 20));

      expect(cloned.x).toBe(10);
      expect(cloned.y).toBe(20);
      expect(cloned.x2).toBe(110);
      expect(cloned.y2).toBe(70);
    });
  });
});
