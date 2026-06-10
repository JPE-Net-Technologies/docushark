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
});
