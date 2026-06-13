import { describe, it, expect } from 'vitest';
import { findConnectedShapes } from './connectivity';
import { DEFAULT_RECTANGLE, DEFAULT_CONNECTOR, type Shape } from './Shape';

function node(id: string): Shape {
  return { ...DEFAULT_RECTANGLE, id, type: 'rectangle', x: 0, y: 0, width: 100, height: 60 } as Shape;
}

function conn(id: string, from: string | null, to: string | null): Shape {
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

describe('findConnectedShapes', () => {
  it('returns the seed alone when nothing connects to it', () => {
    const shapes = map([node('a'), node('b')]);
    expect(findConnectedShapes(['a'], shapes).sort()).toEqual(['a']);
  });

  it('walks a chain through connectors, including the connectors', () => {
    // a —c1→ b —c2→ c ;  d is separate.
    const shapes = map([
      node('a'), node('b'), node('c'), node('d'),
      conn('c1', 'a', 'b'), conn('c2', 'b', 'c'),
    ]);
    expect(findConnectedShapes(['a'], shapes).sort()).toEqual(['a', 'b', 'c', 'c1', 'c2']);
  });

  it('traverses in both directions regardless of connector orientation', () => {
    const shapes = map([node('a'), node('b'), node('c'), conn('c1', 'a', 'b'), conn('c2', 'c', 'b')]);
    // Seeding the middle reaches both ends.
    expect(findConnectedShapes(['b'], shapes).sort()).toEqual(['a', 'b', 'c', 'c1', 'c2']);
  });

  it('seeding a connector selects its component', () => {
    const shapes = map([node('a'), node('b'), conn('c1', 'a', 'b')]);
    expect(findConnectedShapes(['c1'], shapes).sort()).toEqual(['a', 'b', 'c1']);
  });

  it('ignores dangling connector endpoints', () => {
    // c1 binds a to a missing shape; only a (and c1) come back.
    const shapes = map([node('a'), conn('c1', 'a', 'ghost')]);
    expect(findConnectedShapes(['a'], shapes).sort()).toEqual(['a', 'c1']);
  });

  it('unions the components of multiple seeds', () => {
    const shapes = map([
      node('a'), node('b'), conn('c1', 'a', 'b'),
      node('x'), node('y'), conn('c2', 'x', 'y'),
    ]);
    expect(findConnectedShapes(['a', 'x'], shapes).sort()).toEqual(['a', 'b', 'c1', 'c2', 'x', 'y']);
  });

  it('does not span two components when only one is seeded', () => {
    const shapes = map([
      node('a'), node('b'), conn('c1', 'a', 'b'),
      node('x'), node('y'), conn('c2', 'x', 'y'),
    ]);
    expect(findConnectedShapes(['a'], shapes).sort()).toEqual(['a', 'b', 'c1']);
  });

  it('skips seed ids that do not exist', () => {
    const shapes = map([node('a')]);
    expect(findConnectedShapes(['ghost'], shapes)).toEqual([]);
  });
});
