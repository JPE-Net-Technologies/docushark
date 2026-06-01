import { describe, it, expect } from 'vitest';
import { localToWorld, worldToLocal, getLocalCorners, getWorldCorners } from './localSpace';
import { Vec2 } from '../../math/Vec2';

describe('localSpace', () => {
  it('translates local to world with no rotation', () => {
    const w = localToWorld(new Vec2(1, 0), { x: 10, y: 20, rotation: 0 });
    expect(w.x).toBeCloseTo(11);
    expect(w.y).toBeCloseTo(20);
  });

  it('round-trips local⇄world for a rotated shape', () => {
    const shape = { x: 5, y: -3, rotation: Math.PI / 3 };
    const p = new Vec2(7, 11);
    const back = worldToLocal(localToWorld(p, shape), shape);
    expect(back.x).toBeCloseTo(7);
    expect(back.y).toBeCloseTo(11);
  });

  it('produces 4 corners centered on the origin', () => {
    const corners = getLocalCorners(2, 2);
    expect(corners).toHaveLength(4);
    expect(corners[0]!.x).toBeCloseTo(-1);
    expect(corners[0]!.y).toBeCloseTo(-1);
    expect(corners[2]!.x).toBeCloseTo(1);
    expect(corners[2]!.y).toBeCloseTo(1);
  });

  it('places world corners around the shape center', () => {
    const corners = getWorldCorners({ x: 100, y: 100, rotation: 0 }, 10, 6);
    expect(corners[0]!.x).toBeCloseTo(95);
    expect(corners[0]!.y).toBeCloseTo(97);
    expect(corners[2]!.x).toBeCloseTo(105);
    expect(corners[2]!.y).toBeCloseTo(103);
  });
});
