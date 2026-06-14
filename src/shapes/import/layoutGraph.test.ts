import { describe, it, expect } from 'vitest';
import { layoutGraph } from './layoutGraph';

const N = (id: string, width = 100, height = 60) => ({ id, width, height });

describe('layoutGraph', () => {
  it('stacks a chain into successive ranks (TB: increasing y)', () => {
    const pos = layoutGraph([N('a'), N('b'), N('c')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
    expect(pos.get('a')!.y).toBeLessThan(pos.get('b')!.y);
    expect(pos.get('b')!.y).toBeLessThan(pos.get('c')!.y);
  });

  it('places siblings of one rank on the same row, spread on x', () => {
    // a → b, a → c : b and c share rank 1.
    const pos = layoutGraph([N('a'), N('b'), N('c')], [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }]);
    expect(pos.get('b')!.y).toBe(pos.get('c')!.y);
    expect(pos.get('b')!.x).not.toBe(pos.get('c')!.x);
  });

  it('LR flows along x instead of y', () => {
    const pos = layoutGraph([N('a'), N('b')], [{ from: 'a', to: 'b' }], { direction: 'LR' });
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x);
    expect(pos.get('a')!.y).toBe(pos.get('b')!.y);
  });

  it('BT reverses the flow axis', () => {
    const pos = layoutGraph([N('a'), N('b')], [{ from: 'a', to: 'b' }], { direction: 'BT' });
    expect(pos.get('a')!.y).toBeGreaterThan(pos.get('b')!.y);
  });

  it('terminates on cycles (bounded relaxation)', () => {
    const pos = layoutGraph(
      [N('a'), N('b'), N('c')],
      [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }]
    );
    expect(pos.size).toBe(3);
    expect(Number.isFinite(pos.get('a')!.y)).toBe(true);
  });

  it('is deterministic across runs', () => {
    const nodes = [N('a'), N('b'), N('c')];
    const edges = [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }];
    expect(JSON.stringify([...layoutGraph(nodes, edges)])).toBe(
      JSON.stringify([...layoutGraph(nodes, edges)])
    );
  });

  it('orders siblings under their parents to avoid the crossing (v2 ordering)', () => {
    // Two parents each with a dedicated child, listed in crossing order:
    // a -> y, b -> x. v1 (input-order packing) drew an X; v2 uncrosses it.
    const pos = layoutGraph(
      [N('a'), N('b'), N('x'), N('y')],
      [{ from: 'a', to: 'y' }, { from: 'b', to: 'x' }]
    );
    // a left of b implies y left of x (the edges no longer cross).
    expect(pos.get('a')!.x < pos.get('b')!.x).toBe(pos.get('y')!.x < pos.get('x')!.x);
  });

  it('stays deterministic on a graph with a cycle and a long edge', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => N(id));
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' }, // cycle back
      { from: 'a', to: 'd' },
      { from: 'd', to: 'e' },
      { from: 'a', to: 'f' }, // long edge (span > 1)
      { from: 'e', to: 'f' },
    ];
    expect(JSON.stringify([...layoutGraph(nodes, edges)])).toBe(
      JSON.stringify([...layoutGraph(nodes, edges)])
    );
  });

  it('ignores self-loops and unknown endpoints without crashing', () => {
    const pos = layoutGraph(
      [N('a'), N('b')],
      [{ from: 'a', to: 'a' }, { from: 'a', to: 'b' }, { from: 'a', to: 'ghost' }]
    );
    expect(pos.size).toBe(2);
    expect(pos.get('a')!.y).toBeLessThan(pos.get('b')!.y);
  });
});
