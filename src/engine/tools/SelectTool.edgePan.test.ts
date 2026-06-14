/**
 * JP-307 Slice 3 — drag-to-edge auto-pan velocity.
 *
 * `edgePanVelocity` is the pure core of the auto-pan loop: given the cursor's
 * screen position and the viewport size, it returns the camera pan velocity
 * (screen px/frame). Zero in the interior, ramping toward the edges. A positive
 * component points toward the right/bottom edge.
 */
import { describe, it, expect } from 'vitest';
import { edgePanVelocity } from './SelectTool';
import { Vec2 } from '../../math/Vec2';

const W = 800;
const H = 600;
const MAX = 18; // EDGE_PAN_MAX_SPEED
const THRESHOLD = 48;

describe('edgePanVelocity (JP-307 drag-to-edge auto-pan)', () => {
  it('is zero in the interior', () => {
    const v = edgePanVelocity(new Vec2(400, 300), W, H);
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
  });

  it('is zero just inside the threshold band', () => {
    // Exactly THRESHOLD px from each edge is the boundary — still interior.
    const v = edgePanVelocity(new Vec2(THRESHOLD, THRESHOLD), W, H);
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
  });

  it('ramps toward the right edge (positive x)', () => {
    const v = edgePanVelocity(new Vec2(W - 10, 300), W, H); // depth 38 of 48
    expect(v.x).toBeCloseTo((38 / THRESHOLD) * MAX, 5);
    expect(v.y).toBe(0);
    expect(v.x).toBeGreaterThan(0);
  });

  it('ramps toward the left edge (negative x)', () => {
    const v = edgePanVelocity(new Vec2(10, 300), W, H); // depth 38
    expect(v.x).toBeCloseTo(-(38 / THRESHOLD) * MAX, 5);
    expect(v.y).toBe(0);
  });

  it('ramps toward the bottom edge (positive y)', () => {
    const v = edgePanVelocity(new Vec2(400, H - 5), W, H); // depth 43
    expect(v.y).toBeCloseTo((43 / THRESHOLD) * MAX, 5);
    expect(v.x).toBe(0);
  });

  it('caps at max speed at and beyond the edge', () => {
    expect(edgePanVelocity(new Vec2(W, 300), W, H).x).toBeCloseTo(MAX, 5);
    // Beyond the viewport (e.g. pointer dragged off-canvas) stays capped.
    expect(edgePanVelocity(new Vec2(W + 200, 300), W, H).x).toBeCloseTo(MAX, 5);
    expect(edgePanVelocity(new Vec2(-200, 300), W, H).x).toBeCloseTo(-MAX, 5);
  });

  it('combines both axes in a corner', () => {
    const v = edgePanVelocity(new Vec2(W, H), W, H);
    expect(v.x).toBeCloseTo(MAX, 5);
    expect(v.y).toBeCloseTo(MAX, 5);
  });
});
