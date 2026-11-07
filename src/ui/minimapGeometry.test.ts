/**
 * Minimap geometry (DSK-212).
 */
import { describe, it, expect } from 'vitest';
import {
  contains,
  fitFrame,
  mapToWorld,
  mapWorld,
  nextMapWorld,
  viewportRect,
  worldToMap,
  zoomAround,
  type Rect,
  union,
} from './minimapGeometry';

describe('minimap geometry (DSK-212)', () => {
  it("reads the camera as the screen's centre", () => {
    expect(viewportRect({ x: 100, y: 50, zoom: 2 }, 800, 600)).toEqual({ minX: -100, minY: -100, maxX: 300, maxY: 200 });
  });

  it('fits a world area into the map with one scale, centred, and converts both ways', () => {
    const world: Rect = { minX: 0, minY: 0, maxX: 400, maxY: 100 };
    const frame = fitFrame(world, 200, 100);
    expect(frame.scale).toBe(0.5);
    expect(worldToMap(frame, { x: 200, y: 50 })).toEqual({ x: 100, y: 50 });
    expect(mapToWorld(frame, worldToMap(frame, { x: 37, y: 12 }))).toEqual({ x: 37, y: 12 });
  });

  it('keeps the frame while the viewport and content stay inside it', () => {
    const content: Rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const first = nextMapWorld(null, content, { minX: 10, minY: 10, maxX: 60, maxY: 60 });
    expect(nextMapWorld(first, content, { minX: 20, minY: 20, maxX: 70, maxY: 70 })).toBe(first);
  });

  it('grows the frame when the viewport leaves it, or the content does', () => {
    const content: Rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const first = nextMapWorld(null, content, { minX: 10, minY: 10, maxX: 60, maxY: 60 });
    const panned = nextMapWorld(first, content, { minX: 500, minY: 0, maxX: 550, maxY: 50 });
    expect(panned.maxX).toBeGreaterThan(550);
    const grown = nextMapWorld(first, { ...content, maxX: 900 }, { minX: 10, minY: 10, maxX: 60, maxY: 60 });
    expect(grown.maxX).toBeGreaterThan(900);
  });

  it('tells whether one area lies inside another, on every side', () => {
    const outer: Rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(contains(outer, { minX: 0, minY: 0, maxX: 100, maxY: 100 })).toBe(true);
    expect(contains(outer, { minX: -1, minY: 0, maxX: 50, maxY: 50 })).toBe(false);
    expect(contains(outer, { minX: 0, minY: -1, maxX: 50, maxY: 50 })).toBe(false);
    expect(contains(outer, { minX: 50, minY: 50, maxX: 101, maxY: 100 })).toBe(false);
    expect(contains(outer, { minX: 50, minY: 50, maxX: 100, maxY: 101 })).toBe(false);
  });

  it('joins two areas, taking each side from whichever reaches further', () => {
    expect(union({ minX: -5, minY: 0, maxX: 10, maxY: 20 }, { minX: 0, minY: -3, maxX: 12, maxY: 8 })).toEqual({
      minX: -5,
      minY: -3,
      maxX: 12,
      maxY: 20,
    });
  });

  it('frames the viewport alone, with a margin, on an empty canvas', () => {
    expect(mapWorld(null, { minX: 0, minY: 0, maxX: 100, maxY: 50 })).toEqual({ minX: -10, minY: -10, maxX: 110, maxY: 60 });
  });

  it('zooms around a point without moving it on screen', () => {
    const camera = { x: 0, y: 0, zoom: 1 };
    const point = { x: 200, y: 100 };
    const next = zoomAround(camera, point, 2);
    // The point's offset from the screen centre, in screen pixels, is unchanged.
    expect((point.x - next.x) * next.zoom).toBeCloseTo((point.x - camera.x) * camera.zoom);
    expect((point.y - next.y) * next.zoom).toBeCloseTo((point.y - camera.y) * camera.zoom);
  });
});
