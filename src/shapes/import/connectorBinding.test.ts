import { describe, it, expect } from 'vitest';
import { nearestEdgeAnchor, boxFromTopLeft, type AnchorBox } from './connectorBinding';

const UNIT: AnchorBox = { cx: 0, cy: 0, width: 100, height: 100 };

describe('nearestEdgeAnchor', () => {
  it('picks the cardinal side facing the toward-point', () => {
    expect(nearestEdgeAnchor(UNIT, { x: 500, y: 0 })).toBe('right');
    expect(nearestEdgeAnchor(UNIT, { x: -500, y: 0 })).toBe('left');
    expect(nearestEdgeAnchor(UNIT, { x: 0, y: 500 })).toBe('bottom');
    expect(nearestEdgeAnchor(UNIT, { x: 0, y: -500 })).toBe('top');
  });

  it('never resolves to the centre (the JP-196 bug)', () => {
    // Even a point essentially at the centre yields an edge, not 'center'.
    const side = nearestEdgeAnchor(UNIT, { x: 0, y: 0 });
    expect(['top', 'right', 'bottom', 'left']).toContain(side);
  });

  it('respects aspect ratio — same raw point, opposite side per box shape', () => {
    // The point (50,50) is a 45° tie on a square, but half-extent normalisation
    // makes the *short* axis dominate: a wide (short) box sends it to bottom,
    // a tall (narrow) box sends it to right.
    const wide: AnchorBox = { cx: 0, cy: 0, width: 400, height: 40 };
    const tall: AnchorBox = { cx: 0, cy: 0, width: 40, height: 400 };
    expect(nearestEdgeAnchor(wide, { x: 50, y: 50 })).toBe('bottom');
    expect(nearestEdgeAnchor(tall, { x: 50, y: 50 })).toBe('right');
  });

  it('undoes box rotation before choosing the side', () => {
    // Box rotated 90° clockwise; a point to the world-right approaches what is
    // locally the top edge.
    const rotated: AnchorBox = { cx: 0, cy: 0, width: 100, height: 100, rotation: Math.PI / 2 };
    expect(nearestEdgeAnchor(rotated, { x: 500, y: 0 })).toBe('top');
  });

  it('boxFromTopLeft centres a top-left rect', () => {
    const box = boxFromTopLeft(10, 20, 100, 40);
    expect(box).toEqual({ cx: 60, cy: 40, width: 100, height: 40, rotation: 0 });
  });
});
