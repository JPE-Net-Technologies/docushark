import { describe, it, expect } from 'vitest';
import { greedyFas } from './acyclic';

/** Kahn's algorithm consumes every node iff the orientation is acyclic. */
function isAcyclic(n: number, edges: ReadonlyArray<readonly [number, number]>): boolean {
  const indeg = new Array(n).fill(0);
  for (const [, v] of edges) indeg[v] += 1;
  const queue: number[] = [];
  for (let v = 0; v < n; v++) if (indeg[v] === 0) queue.push(v);
  let seen = 0;
  while (queue.length > 0) {
    const v = queue.pop()!;
    seen += 1;
    for (const [u, w] of edges) {
      if (u === v) {
        indeg[w] -= 1;
        if (indeg[w] === 0) queue.push(w);
      }
    }
  }
  return seen === n;
}

describe('greedyFas (cycle removal)', () => {
  it('reverses nothing in an acyclic graph', () => {
    const edges: Array<readonly [number, number]> = [[0, 1], [1, 2], [0, 2]];
    expect(greedyFas(3, edges)).toEqual([false, false, false]);
  });

  it('reverses exactly one edge in a 3-cycle, deterministically', () => {
    const edges: Array<readonly [number, number]> = [[0, 1], [1, 2], [2, 0]];
    const flags = greedyFas(3, edges);
    expect(flags.filter(Boolean).length).toBe(1);
    // Node 0 wins the outdeg-indeg tie by lowest index, so it heads the
    // sequence and the edge back into it (2 -> 0) is the feedback arc.
    expect(flags).toEqual([false, false, true]);
  });

  it('reverses one edge in a 2-cycle', () => {
    const flags = greedyFas(2, [[0, 1], [1, 0]]);
    expect(flags.filter(Boolean).length).toBe(1);
  });

  it('produces an acyclic orientation after reversal', () => {
    const edges: Array<readonly [number, number]> = [[0, 1], [1, 2], [2, 0], [2, 3], [3, 1]];
    const flags = greedyFas(4, edges);
    const oriented = edges.map(([u, v], i) => (flags[i] ? ([v, u] as const) : ([u, v] as const)));
    expect(isAcyclic(4, oriented)).toBe(true);
  });
});
