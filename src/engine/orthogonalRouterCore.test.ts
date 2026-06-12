import { describe, it, expect } from 'vitest';
import { routeOrthogonalAvoiding, MAX_OVG_OBSTACLES } from './orthogonalRouterCore';
import { Vec2 } from '../math/Vec2';
import { Box } from '../math/Box';

type Pt = { x: number; y: number };

/** Does an axis-aligned segment cross a box's interior (edge-grazing is clear)? */
function segCrossesBox(a: Pt, b: Pt, o: Box): boolean {
  if (a.y === b.y) {
    if (a.y <= o.minY || a.y >= o.maxY) return false;
    return Math.max(a.x, b.x) > o.minX && Math.min(a.x, b.x) < o.maxX;
  }
  if (a.x <= o.minX || a.x >= o.maxX) return false;
  return Math.max(a.y, b.y) > o.minY && Math.min(a.y, b.y) < o.maxY;
}

function fullPath(start: Vec2, waypoints: Pt[], end: Vec2): Pt[] {
  return [{ x: start.x, y: start.y }, ...waypoints, { x: end.x, y: end.y }];
}

function assertAxisAligned(path: Pt[]): void {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    expect(a.x === b.x || a.y === b.y).toBe(true);
  }
}

describe('routeOrthogonalAvoiding (JP-167 Tier 2)', () => {
  it('returns null when there are no obstacles', () => {
    expect(routeOrthogonalAvoiding(new Vec2(0, 0), new Vec2(200, 0), new Vec2(1, 0), [])).toBeNull();
  });

  it('returns null when the graph is too large (safety valve)', () => {
    const obstacles = Array.from(
      { length: MAX_OVG_OBSTACLES + 1 },
      (_, i) => new Box(i * 10, -5, i * 10 + 5, 5)
    );
    expect(routeOrthogonalAvoiding(new Vec2(0, 0), new Vec2(500, 0), new Vec2(1, 0), obstacles)).toBeNull();
  });

  it('routes around a wall blocking the direct path', () => {
    const start = new Vec2(0, 0);
    const end = new Vec2(200, 0);
    const wall = new Box(80, -20, 120, 20); // straddles y=0 between the endpoints

    const waypoints = routeOrthogonalAvoiding(start, end, new Vec2(1, 0), [wall]);
    expect(waypoints).not.toBeNull();

    const path = fullPath(start, waypoints!, end);
    assertAxisAligned(path);
    expect(waypoints!.length).toBeGreaterThan(0); // it actually detoured

    // No segment crosses the wall interior.
    for (let i = 1; i < path.length; i++) {
      expect(segCrossesBox(path[i - 1]!, path[i]!, wall)).toBe(false);
    }

    // Reaches the endpoints.
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 200, y: 0 });
  });

  it('is deterministic for identical inputs', () => {
    const route = () =>
      routeOrthogonalAvoiding(new Vec2(0, 0), new Vec2(200, 0), new Vec2(1, 0), [
        new Box(80, -20, 120, 20),
      ]);
    expect(route()).toEqual(route());
  });

  it('routes around two stacked obstacles', () => {
    const start = new Vec2(0, 0);
    const end = new Vec2(300, 0);
    const obstacles = [new Box(80, -60, 120, 0), new Box(80, 0, 120, 60)]; // wall split at y=0

    const waypoints = routeOrthogonalAvoiding(start, end, new Vec2(1, 0), obstacles);
    expect(waypoints).not.toBeNull();
    const path = fullPath(start, waypoints!, end);
    assertAxisAligned(path);
    for (const o of obstacles) {
      for (let i = 1; i < path.length; i++) {
        expect(segCrossesBox(path[i - 1]!, path[i]!, o)).toBe(false);
      }
    }
  });
});
