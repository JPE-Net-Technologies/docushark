import { describe, it, expect } from 'vitest';
import { assignLayers, normalize, type LGraph } from './rank';
import { minimizeCrossings } from './order';
import { assignCoords } from './coords';
import type { Point } from '../layoutGraph';

const NODE_W = 160;
const NODE_H = 72;
const NODE_GAP = 48;
const RANK_GAP = 72;

function coords(n: number, edges: Array<readonly [number, number]>): { g: LGraph; pos: Point[] } {
  const layer = assignLayers(n, edges);
  const g = normalize(n, new Array(n).fill(NODE_W), new Array(n).fill(NODE_H), layer, edges);
  const order = minimizeCrossings(g);
  const pos = assignCoords(g, order, { nodeGap: NODE_GAP, rankGap: RANK_GAP });
  return { g, pos };
}

describe('assignCoords (priority method)', () => {
  it('produces no overlapping real nodes', () => {
    const { g, pos } = coords(5, [[0, 1], [0, 2], [0, 3], [1, 4], [2, 4], [3, 4], [0, 4]]);
    for (let a = 0; a < g.nReal; a++) {
      for (let b = a + 1; b < g.nReal; b++) {
        const dx = Math.abs(pos[a]!.x - pos[b]!.x);
        const dy = Math.abs(pos[a]!.y - pos[b]!.y);
        const overlapX = dx < (g.w[a]! + g.w[b]!) / 2;
        const overlapY = dy < (g.h[a]! + g.h[b]!) / 2;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it('places the minimum real-node center at the origin', () => {
    const { g, pos } = coords(4, [[0, 1], [0, 2], [1, 3], [2, 3]]);
    let minX = Infinity;
    let minY = Infinity;
    for (let v = 0; v < g.nReal; v++) {
      minX = Math.min(minX, pos[v]!.x);
      minY = Math.min(minY, pos[v]!.y);
    }
    expect(minX).toBe(0);
    expect(minY).toBe(0);
  });

  it('centers a single parent over its two children', () => {
    const { pos } = coords(3, [[0, 1], [0, 2]]);
    const mid = (pos[1]!.x + pos[2]!.x) / 2;
    expect(Math.abs(pos[0]!.x - mid)).toBeLessThan(1);
  });

  it('separates layers by node height + rank gap', () => {
    const { pos } = coords(2, [[0, 1]]);
    expect(pos[1]!.y - pos[0]!.y).toBe(NODE_H + RANK_GAP);
  });
});
