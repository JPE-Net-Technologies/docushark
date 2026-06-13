import { describe, it, expect } from 'vitest';
import { assignLayers, normalize, type LGraph } from './rank';
import { minimizeCrossings, totalCrossings } from './order';

function graph(n: number, edges: Array<readonly [number, number]>): LGraph {
  const layer = assignLayers(n, edges);
  return normalize(n, new Array(n).fill(160), new Array(n).fill(72), layer, edges);
}

/** Position index of every node within its layer, given an ordering. */
function positions(g: LGraph, order: ReadonlyArray<ReadonlyArray<number>>): number[] {
  const pos = new Array(g.nTotal).fill(0);
  for (const layer of order) layer.forEach((v, i) => (pos[v] = i));
  return pos;
}

describe('crossing counting + minimization', () => {
  it('counts zero crossings for parallel edges', () => {
    // 0->2, 1->3 with order [0,1] / [2,3]: parallel, no crossing.
    const g = graph(4, [[0, 2], [1, 3]]);
    const order = [[0, 1], [2, 3]];
    expect(totalCrossings(g, order, positions(g, order))).toBe(0);
  });

  it('counts one crossing for an X pattern', () => {
    // 0->3, 1->2 with order [0,1] / [2,3]: the segments cross once.
    const g = graph(4, [[0, 3], [1, 2]]);
    const order = [[0, 1], [2, 3]];
    expect(totalCrossings(g, order, positions(g, order))).toBe(1);
  });

  it('orders away the X crossing', () => {
    const g = graph(4, [[0, 3], [1, 2]]);
    const order = minimizeCrossings(g);
    expect(totalCrossings(g, order, positions(g, order))).toBe(0);
  });

  it('keeps exactly one crossing for K2,2', () => {
    // K2,2 (0,1 -> 2,3 fully connected) cannot do better than 1 crossing.
    const g = graph(4, [[0, 2], [0, 3], [1, 2], [1, 3]]);
    const order = minimizeCrossings(g);
    expect(totalCrossings(g, order, positions(g, order))).toBe(1);
  });

  it('is deterministic', () => {
    const edges: Array<readonly [number, number]> = [[0, 4], [1, 3], [2, 5], [0, 5], [1, 4], [2, 3]];
    const g1 = graph(6, edges);
    const g2 = graph(6, edges);
    expect(minimizeCrossings(g1)).toEqual(minimizeCrossings(g2));
  });
});
