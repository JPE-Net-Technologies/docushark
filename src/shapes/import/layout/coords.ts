/**
 * Coordinate assignment: the priority method (Sugiyama et al. 1981, as
 * refined by Gansner et al. 1993).
 *
 * Alternating down/up sweeps move each node toward the median x of its
 * neighbors in the fixed adjacent layer, processed in descending priority
 * (degree toward the fixed layer). A move may push lower-priority neighbors
 * aside but never equal-or-higher ones, so well-connected nodes and virtual
 * chains end up aligned — chains straighten instead of zigzagging through
 * ranks of different widths.
 *
 * TS twin of `relay/src/mcp/layout/coords.rs` — keep the two in step.
 */

import type { LGraph } from './rank';
import type { Point } from '../layoutGraph';

/** Cross-axis gap when at least one of the two neighbors is a virtual node. */
const VIRTUAL_GAP = 20;

/** Coordinate sweeps (alternating down/up). */
const SWEEPS = 8;

export interface CoordOptions {
  /** Cross-axis gap between real sibling nodes within a rank. */
  nodeGap: number;
  /** Flow-axis gap between ranks. */
  rankGap: number;
}

/**
 * Assign center coordinates (pipeline space: x = cross axis, y = flow axis)
 * to every node, real + virtual. Real nodes are translated so their minimum
 * center sits at (0, 0).
 */
export function assignCoords(
  g: LGraph,
  order: ReadonlyArray<ReadonlyArray<number>>,
  options: CoordOptions
): Point[] {
  const up: number[][] = Array.from({ length: g.nTotal }, () => []);
  const down: number[][] = Array.from({ length: g.nTotal }, () => []);
  for (const [u, v] of g.segments) {
    down[u]!.push(v);
    up[v]!.push(u);
  }

  const separation = (a: number, b: number): number => {
    const gap = a < g.nReal && b < g.nReal ? options.nodeGap : VIRTUAL_GAP;
    return g.w[a]! / 2 + g.w[b]! / 2 + gap;
  };

  // Initial x: pack each layer left-to-right from 0.
  const x: number[] = new Array(g.nTotal).fill(0);
  for (const layer of order) {
    for (let i = 1; i < layer.length; i++) {
      x[layer[i]!] = x[layer[i - 1]!]! + separation(layer[i - 1]!, layer[i]!);
    }
  }

  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    if (sweep % 2 === 0) {
      for (let l = 1; l < order.length; l++) {
        priorityPass(g, order[l]!, up, x, separation);
      }
    } else {
      for (let l = order.length - 2; l >= 0; l--) {
        priorityPass(g, order[l]!, down, x, separation);
      }
    }
  }

  // Flow axis: stack layers by max node height + rankGap.
  const layerH: number[] = new Array(g.nLayers).fill(0);
  for (let v = 0; v < g.nTotal; v++) {
    const l = g.layer[v]!;
    if (g.h[v]! > layerH[l]!) layerH[l] = g.h[v]!;
  }
  const layerCy: number[] = new Array(g.nLayers).fill(0);
  let top = 0;
  for (let l = 0; l < g.nLayers; l++) {
    layerCy[l] = top + layerH[l]! / 2;
    top += layerH[l]! + options.rankGap;
  }

  // Translate so the minimum real-node center is (0, 0).
  let minX = Infinity;
  let minCy = Infinity;
  for (let v = 0; v < g.nReal; v++) {
    if (x[v]! < minX) minX = x[v]!;
    const cy = layerCy[g.layer[v]!]!;
    if (cy < minCy) minCy = cy;
  }
  const dx = g.nReal > 0 ? -minX : 0;
  const dy = g.nReal > 0 ? -minCy : 0;

  const out: Point[] = [];
  for (let v = 0; v < g.nTotal; v++) {
    out.push({ x: x[v]! + dx, y: layerCy[g.layer[v]!]! + dy });
  }
  return out;
}

/**
 * One priority pass over `layer`: nodes in descending priority move toward
 * the median x of their neighbors in the fixed layer, pushing only
 * lower-priority nodes aside.
 */
function priorityPass(
  g: LGraph,
  layer: ReadonlyArray<number>,
  adj: ReadonlyArray<ReadonlyArray<number>>,
  x: number[],
  separation: (a: number, b: number) => number
): void {
  const priority = (v: number): number => (v >= g.nReal ? Infinity : adj[v]!.length);

  // Visit order: descending priority, position (left-to-right) on ties.
  const visit = layer.map((_, i) => i);
  visit.sort((i, j) => {
    const pi = priority(layer[i]!);
    const pj = priority(layer[j]!);
    if (pi !== pj) return pj - pi;
    return i - j;
  });

  for (const i of visit) {
    const v = layer[i]!;
    const neigh = adj[v]!;
    if (neigh.length === 0) continue;
    const desired = median(neigh.map((u) => x[u]!));
    const p = priority(v);

    if (desired > x[v]!) {
      // Wall: nearest right neighbor with priority >= p.
      let limit = Infinity;
      let acc = 0;
      for (let j = i + 1; j < layer.length; j++) {
        acc += separation(layer[j - 1]!, layer[j]!);
        if (priority(layer[j]!) >= p) {
          limit = x[layer[j]!]! - acc;
          break;
        }
      }
      const newX = Math.min(desired, limit);
      if (newX > x[v]!) {
        x[v] = newX;
        for (let j = i + 1; j < layer.length; j++) {
          const minX = x[layer[j - 1]!]! + separation(layer[j - 1]!, layer[j]!);
          if (x[layer[j]!]! < minX) {
            x[layer[j]!] = minX;
          } else {
            break;
          }
        }
      }
    } else if (desired < x[v]!) {
      let limit = -Infinity;
      let acc = 0;
      for (let j = i - 1; j >= 0; j--) {
        acc += separation(layer[j]!, layer[j + 1]!);
        if (priority(layer[j]!) >= p) {
          limit = x[layer[j]!]! + acc;
          break;
        }
      }
      const newX = Math.max(desired, limit);
      if (newX < x[v]!) {
        x[v] = newX;
        for (let j = i - 1; j >= 0; j--) {
          const maxX = x[layer[j + 1]!]! - separation(layer[j]!, layer[j + 1]!);
          if (x[layer[j]!]! > maxX) {
            x[layer[j]!] = maxX;
          } else {
            break;
          }
        }
      }
    }
  }
}

/** Median of the values; mean of the two middles on even counts. */
function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  return n % 2 === 1 ? v[(n - 1) / 2]! : (v[n / 2 - 1]! + v[n / 2]!) / 2;
}
