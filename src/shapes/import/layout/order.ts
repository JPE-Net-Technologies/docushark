/**
 * Vertex ordering / crossing minimization.
 *
 * Layer-by-layer barycenter sweeps (Sugiyama et al. 1981) with a bounded
 * adjacent-transpose polish after each sweep, scored by exact bilayer
 * crossing counts (Fenwick-tree inversion counting). The best ordering seen
 * across all sweeps wins; ties keep the earlier one.
 *
 * Determinism: the initial order is ascending node index (= input order for
 * real nodes, edge order for virtuals), barycenter sorts are stable
 * (Array.prototype.sort is stable per ES2019), and sweep/transpose counts
 * are fixed.
 *
 * TS twin of `relay/src/mcp/layout/order.rs` — keep the two in step.
 */

import type { LGraph } from './rank';

/** Number of barycenter sweeps (alternating down/up). */
const SWEEPS = 8;
/** Max transpose passes after each sweep. */
const TRANSPOSE_PASSES = 4;

/** Compute a per-layer node ordering minimizing edge crossings (heuristic). */
export function minimizeCrossings(g: LGraph): number[][] {
  const order: number[][] = Array.from({ length: g.nLayers }, () => []);
  for (let v = 0; v < g.nTotal; v++) {
    order[g.layer[v]!]!.push(v); // ascending index per layer
  }
  if (g.segments.length === 0 || g.nLayers <= 1) {
    return order;
  }

  // Adjacency over unit segments: up = neighbors one layer above, down =
  // neighbors one layer below. Built in segment order (deterministic).
  const up: number[][] = Array.from({ length: g.nTotal }, () => []);
  const down: number[][] = Array.from({ length: g.nTotal }, () => []);
  for (const [u, v] of g.segments) {
    down[u]!.push(v);
    up[v]!.push(u);
  }

  const pos = positions(g.nTotal, order);
  let best = order.map((layer) => [...layer]);
  let bestCrossings = totalCrossings(g, order, pos);

  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    if (sweep % 2 === 0) {
      for (let l = 1; l < g.nLayers; l++) {
        barycenterSort(order[l]!, up, pos);
      }
    } else {
      for (let l = g.nLayers - 2; l >= 0; l--) {
        barycenterSort(order[l]!, down, pos);
      }
    }
    transpose(order, pos, up, down);

    const crossings = totalCrossings(g, order, pos);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = order.map((layer) => [...layer]);
      if (crossings === 0) break;
    }
  }

  return best;
}

function positions(nTotal: number, order: ReadonlyArray<ReadonlyArray<number>>): number[] {
  const pos: number[] = new Array(nTotal).fill(0);
  for (const layer of order) {
    layer.forEach((v, i) => {
      pos[v] = i;
    });
  }
  return pos;
}

/**
 * Stable-sort one layer by the mean position of its neighbors in the fixed
 * adjacent layer; nodes without neighbors there keep their current position
 * as the key (so they hold station instead of jumping to one end).
 */
function barycenterSort(layer: number[], adj: ReadonlyArray<ReadonlyArray<number>>, pos: number[]): void {
  const keyed = layer.map((v) => {
    const neigh = adj[v]!;
    const key =
      neigh.length === 0 ? pos[v]! : neigh.reduce((s, u) => s + pos[u]!, 0) / neigh.length;
    return { v, key };
  });
  keyed.sort((a, b) => a.key - b.key);
  keyed.forEach(({ v }, i) => {
    layer[i] = v;
    pos[v] = i;
  });
}

/**
 * Greedy adjacent-exchange polish: swap neighbors whenever it strictly
 * reduces the crossings local to the pair, bounded passes.
 */
function transpose(
  order: number[][],
  pos: number[],
  up: ReadonlyArray<ReadonlyArray<number>>,
  down: ReadonlyArray<ReadonlyArray<number>>
): void {
  for (let pass = 0; pass < TRANSPOSE_PASSES; pass++) {
    let improved = false;
    for (const layer of order) {
      for (let i = 0; i < layer.length - 1; i++) {
        const a = layer[i]!;
        const b = layer[i + 1]!;
        const before = pairCrossings(a, b, up, pos) + pairCrossings(a, b, down, pos);
        const after = pairCrossings(b, a, up, pos) + pairCrossings(b, a, down, pos);
        if (after < before) {
          layer[i] = b;
          layer[i + 1] = a;
          pos[b] = i;
          pos[a] = i + 1;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
}

/**
 * Crossings between the edge bundles of two nodes when `a` sits immediately
 * left of `b`: pairs (p, q) with p in N(a), q in N(b), and p right of q.
 */
function pairCrossings(
  a: number,
  b: number,
  adj: ReadonlyArray<ReadonlyArray<number>>,
  pos: ReadonlyArray<number>
): number {
  let count = 0;
  for (const p of adj[a]!) {
    for (const q of adj[b]!) {
      if (pos[p]! > pos[q]!) count += 1;
    }
  }
  return count;
}

/**
 * Exact crossing count between all adjacent layer pairs: sort each bilayer's
 * segments by upper position and count inversions of the lower positions
 * with a Fenwick tree — O(E log V) per bilayer.
 */
export function totalCrossings(
  g: LGraph,
  order: ReadonlyArray<ReadonlyArray<number>>,
  pos: ReadonlyArray<number>
): number {
  const byUpperLayer: Array<Array<[number, number]>> = Array.from({ length: g.nLayers }, () => []);
  for (const [u, v] of g.segments) {
    byUpperLayer[g.layer[u]!]!.push([pos[u]!, pos[v]!]);
  }

  let total = 0;
  byUpperLayer.forEach((pairs, l) => {
    if (pairs.length < 2) return;
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const lowerLen = order[l + 1]?.length ?? 0;
    const tree = new Fenwick(lowerLen);
    // Walk in sorted order; each segment crosses every already-seen segment
    // whose lower endpoint is strictly to its right.
    pairs.forEach(([, lo], i) => {
      total += i - tree.prefixSum(lo);
      tree.add(lo);
    });
  });
  return total;
}

class Fenwick {
  private readonly tree: number[];

  constructor(n: number) {
    this.tree = new Array(n + 1).fill(0);
  }

  /** Count of added values <= i. */
  prefixSum(i: number): number {
    let idx = i + 1;
    let sum = 0;
    while (idx > 0) {
      sum += this.tree[idx]!;
      idx -= idx & -idx;
    }
    return sum;
  }

  add(i: number): void {
    let idx = i + 1;
    while (idx < this.tree.length) {
      this.tree[idx]! += 1;
      idx += idx & -idx;
    }
  }
}
