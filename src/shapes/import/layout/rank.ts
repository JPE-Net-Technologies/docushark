/**
 * Layer assignment + long-edge normalization.
 *
 * Layering is exact longest-path over the FAS-oriented DAG (`layer[v] =
 * max(layer[u] + 1)` in topological order), followed by one tightening pass
 * that pulls pure sources down next to their nearest successor — the classic
 * longest-path artifact is sources stranded at layer 0 trailing long edges
 * across the whole drawing (one of the import "elongation" causes).
 *
 * Normalization then breaks every edge spanning more than one layer into
 * unit segments through narrow virtual nodes, which is what lets crossing
 * minimization see long edges at every layer they pass through and reserves
 * a channel between real nodes.
 *
 * TS twin of `relay/src/mcp/layout/rank.rs` — keep the two in step.
 */

/** Width reserved by a virtual (dummy) node: the long-edge channel. */
export const DUMMY_SIZE = 8;

/**
 * Longest-path layering of a DAG. `edges` must be acyclic (FAS-oriented) and
 * self-loop free. Returns one layer index per node, compacted so used layers
 * are exactly `0..max`.
 */
export function assignLayers(n: number, edges: ReadonlyArray<readonly [number, number]>): number[] {
  const indeg: number[] = new Array(n).fill(0);
  const outAdj: number[][] = Array.from({ length: n }, () => []);
  const inAdj: number[][] = Array.from({ length: n }, () => []);
  for (const [u, v] of edges) {
    indeg[v]! += 1;
    outAdj[u]!.push(v);
    inAdj[v]!.push(u);
  }

  // Kahn topological order (lowest index first — determinism, though the
  // resulting layers are order-independent).
  const layer: number[] = new Array(n).fill(0);
  const ready: number[] = [];
  for (let v = 0; v < n; v++) {
    if (indeg[v] === 0) ready.push(v);
  }
  while (ready.length > 0) {
    let pick = 0;
    for (let i = 1; i < ready.length; i++) {
      if (ready[i]! < ready[pick]!) pick = i;
    }
    const u = ready[pick]!;
    ready[pick] = ready[ready.length - 1]!;
    ready.pop();
    for (const v of outAdj[u]!) {
      if (layer[v]! < layer[u]! + 1) layer[v] = layer[u]! + 1;
      indeg[v]! -= 1;
      if (indeg[v] === 0) ready.push(v);
    }
  }

  // Tightening: a source with successors sits just above its nearest one.
  for (let v = 0; v < n; v++) {
    if (inAdj[v]!.length === 0 && outAdj[v]!.length > 0) {
      let minSucc = Infinity;
      for (const w of outAdj[v]!) {
        if (layer[w]! < minSucc) minSucc = layer[w]!;
      }
      layer[v] = Math.max(0, minSucc - 1);
    }
  }

  compactLayers(layer);
  return layer;
}

/** Remap layer values so the used set is contiguous from 0. */
function compactLayers(layer: number[]): void {
  if (layer.length === 0) return;
  const used = [...new Set(layer)].sort((a, b) => a - b);
  const remap = new Map(used.map((l, i) => [l, i]));
  for (let i = 0; i < layer.length; i++) {
    layer[i] = remap.get(layer[i]!)!;
  }
}

/**
 * The layered graph after normalization: real nodes first (their input
 * indices), then virtual nodes appended in edge-input order.
 */
export interface LGraph {
  nReal: number;
  nTotal: number;
  /** Node width/height in pipeline space, indexed by node. */
  w: number[];
  h: number[];
  layer: number[];
  nLayers: number;
  /** Unit-span segments, oriented from lower to higher layer. */
  segments: Array<readonly [number, number]>;
}

/**
 * Break long edges into unit segments. `edges` are FAS-oriented (every edge
 * spans at least one layer downward).
 */
export function normalize(
  nReal: number,
  widths: ReadonlyArray<number>,
  heights: ReadonlyArray<number>,
  layer: number[],
  edges: ReadonlyArray<readonly [number, number]>
): LGraph {
  let nLayers = 0;
  for (const l of layer) nLayers = Math.max(nLayers, l + 1);

  const g: LGraph = {
    nReal,
    nTotal: nReal,
    w: [...widths],
    h: [...heights],
    layer,
    nLayers,
    segments: [],
  };

  for (const [u, v] of edges) {
    const lu = g.layer[u]!;
    const lv = g.layer[v]!;
    if (lv - lu === 1) {
      g.segments.push([u, v]);
      continue;
    }
    let prev = u;
    for (let l = lu + 1; l < lv; l++) {
      const d = g.nTotal++;
      g.w.push(DUMMY_SIZE);
      g.h.push(0);
      g.layer.push(l);
      g.segments.push([prev, d]);
      prev = d;
    }
    g.segments.push([prev, v]);
  }

  return g;
}
