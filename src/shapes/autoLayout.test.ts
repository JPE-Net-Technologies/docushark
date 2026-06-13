import { describe, it, expect } from 'vitest';
import './Rectangle'; // registers the 'rectangle' handler for getBounds
import { computeAutoLayout } from './autoLayout';
import { DEFAULT_RECTANGLE, DEFAULT_CONNECTOR, type Shape } from './Shape';

function node(id: string, x: number, y: number): Shape {
  return { ...DEFAULT_RECTANGLE, id, type: 'rectangle', x, y, width: 100, height: 60 } as Shape;
}

function conn(id: string, from: string, to: string): Shape {
  return {
    ...DEFAULT_CONNECTOR,
    id,
    type: 'connector',
    x: 0,
    y: 0,
    x2: 0,
    y2: 0,
    startShapeId: from,
    endShapeId: to,
  } as Shape;
}

function map(shapes: Shape[]): Record<string, Shape> {
  return Object.fromEntries(shapes.map((s) => [s.id, s]));
}

describe('computeAutoLayout', () => {
  it('is a no-op for fewer than two nodes', () => {
    const shapes = map([node('a', 0, 0)]);
    expect(computeAutoLayout(['a'], shapes).size).toBe(0);
  });

  it('stacks a connected chain into ranks (TB: increasing y)', () => {
    // a → b → c, currently scrambled on the canvas.
    const shapes = map([
      node('a', 500, 0), node('b', 0, 300), node('c', 900, 100),
      conn('c1', 'a', 'b'), conn('c2', 'b', 'c'),
    ]);
    const pos = computeAutoLayout(['a', 'b', 'c'], shapes);
    expect(pos.size).toBe(3);
    expect(pos.get('a')!.y).toBeLessThan(pos.get('b')!.y);
    expect(pos.get('b')!.y).toBeLessThan(pos.get('c')!.y);
  });

  it('keeps the group anchored on its current centre', () => {
    const shapes = map([
      node('a', 1000, 1000), node('b', 1000, 1200),
      conn('c1', 'a', 'b'),
    ]);
    const before = { x: (1000 + 1000) / 2, y: (1000 + 1200) / 2 };
    const pos = computeAutoLayout(['a', 'b'], shapes);
    const after = {
      x: (pos.get('a')!.x + pos.get('b')!.x) / 2,
      y: (pos.get('a')!.y + pos.get('b')!.y) / 2,
    };
    expect(Math.round(after.x)).toBe(before.x);
    expect(Math.round(after.y)).toBe(before.y);
  });

  it('only uses connectors whose both endpoints are selected', () => {
    // c2 leaves the selection (b → external); it must not pull layout.
    const shapes = map([
      node('a', 0, 0), node('b', 0, 0), node('external', 5000, 5000),
      conn('c1', 'a', 'b'), conn('c2', 'b', 'external'),
    ]);
    const pos = computeAutoLayout(['a', 'b'], shapes);
    // a and b are ranked (a above b) purely by c1.
    expect(pos.get('a')!.y).toBeLessThan(pos.get('b')!.y);
    expect(pos.has('external')).toBe(false);
  });

  it('ignores connectors in the id list (they are not nodes)', () => {
    const shapes = map([node('a', 0, 0), node('b', 0, 0), conn('c1', 'a', 'b')]);
    const pos = computeAutoLayout(['a', 'b', 'c1'], shapes);
    expect(pos.size).toBe(2);
    expect(pos.has('c1')).toBe(false);
  });

  it('is deterministic', () => {
    const shapes = map([
      node('a', 0, 0), node('b', 200, 0), node('c', 400, 0), node('d', 100, 200),
      conn('c1', 'a', 'd'), conn('c2', 'b', 'd'), conn('c3', 'c', 'd'),
    ]);
    const ids = ['a', 'b', 'c', 'd'];
    expect([...computeAutoLayout(ids, shapes)]).toEqual([...computeAutoLayout(ids, shapes)]);
  });
});
