import { describe, it, expect } from 'vitest';
import { assignLayers, normalize } from './rank';

describe('assignLayers (longest-path + tightening)', () => {
  it('layers a chain by longest path', () => {
    expect(assignLayers(3, [[0, 1], [1, 2]])).toEqual([0, 1, 2]);
  });

  it('tightens pure sources next to their nearest successor', () => {
    // 0 -> 1 -> 2 -> 3, plus source 4 -> 3. Longest-path leaves 4 at layer 0;
    // tightening pulls it to layer 2, one above its successor.
    const layers = assignLayers(5, [[0, 1], [1, 2], [2, 3], [4, 3]]);
    expect(layers[3]).toBe(3);
    expect(layers[4]).toBe(2);
  });

  it('keeps isolated nodes at layer 0', () => {
    expect(assignLayers(3, [[0, 1]])).toEqual([0, 1, 0]);
  });
});

describe('normalize (long-edge dummy insertion)', () => {
  it('inserts span-1 dummies for a long edge', () => {
    // 0 -> 1 -> 2 -> 3 plus a long edge 0 -> 3 (span 3 -> 2 virtuals).
    const edges: Array<readonly [number, number]> = [[0, 1], [1, 2], [2, 3], [0, 3]];
    const layer = assignLayers(4, edges);
    const g = normalize(4, [160, 160, 160, 160], [72, 72, 72, 72], layer, edges);
    expect(g.nTotal).toBe(6);
    // Every segment spans exactly one layer.
    for (const [a, b] of g.segments) {
      expect(g.layer[b]).toBe(g.layer[a]! + 1);
    }
    // The two virtuals sit on layers 1 and 2.
    expect(g.layer[4]).toBe(1);
    expect(g.layer[5]).toBe(2);
  });
});
