/**
 * Shared layered-graph layout for coordinate-less import adapters (JP-164 /
 * JP-85 / JP-305). Mermaid, PlantUML and friends describe a node/edge graph
 * with no geometry, so we assign positions here.
 *
 * v2 (JP-305): the full Sugiyama pipeline ported from the relay's JP-245
 * layout (`relay/src/mcp/layout/`) — greedy feedback-arc-set cycle removal,
 * longest-path layering with source tightening, long-edge normalization
 * through virtual nodes, barycenter/transpose crossing minimization, and
 * priority-method coordinates. This replaces the v1 "rank + pack" layout,
 * whose missing ordering/tightening/alignment were the main cause of
 * crossing spaghetti and awkwardly elongated Mermaid imports.
 *
 * Deterministic (fixed sweep counts, all ties broken by input order) and
 * dependency-free. The pipeline runs in TB space; other flow directions
 * transpose/mirror the result. Returns **centre** positions (DocuShark box
 * shapes are centre-anchored), with the minimum real-node centre at (0, 0)
 * in pipeline space (callers frame via zoomToFit, so origin is arbitrary).
 */

import { greedyFas } from './layout/acyclic';
import { assignLayers, normalize } from './layout/rank';
import { minimizeCrossings } from './layout/order';
import { assignCoords } from './layout/coords';

export interface GraphLayoutNode {
  id: string;
  /** Real rendered size — text/library shapes vary, so layout must read them. */
  width: number;
  height: number;
}

export interface GraphLayoutEdge {
  from: string;
  to: string;
}

/** Flow direction: Top-Bottom, Bottom-Top, Left-Right, Right-Left. */
export type GraphDirection = 'TB' | 'BT' | 'LR' | 'RL';

export interface GraphLayoutOptions {
  direction?: GraphDirection;
  /** Gap between sibling nodes within a rank (cross axis). */
  nodeGap?: number;
  /** Gap between ranks (flow axis). */
  rankGap?: number;
}

export interface Point {
  x: number;
  y: number;
}

export function layoutGraph(
  nodes: GraphLayoutNode[],
  edges: GraphLayoutEdge[],
  options: GraphLayoutOptions = {}
): Map<string, Point> {
  const direction = options.direction ?? 'TB';
  const nodeGap = options.nodeGap ?? 48;
  const rankGap = options.rankGap ?? 72;
  const horizontal = direction === 'LR' || direction === 'RL';
  const mirrored = direction === 'BT' || direction === 'RL';

  const index = new Map(nodes.map((n, i) => [n.id, i]));

  // Self-loops and edges with unknown endpoints don't influence layout.
  const pipelineEdges: Array<readonly [number, number]> = [];
  for (const e of edges) {
    const u = index.get(e.from);
    const v = index.get(e.to);
    if (u === undefined || v === undefined || u === v) continue;
    pipelineEdges.push([u, v]);
  }

  // The pipeline works in TB space: x = cross axis, y = flow axis. For
  // horizontal flow the node footprint transposes with the axes.
  const widths = nodes.map((n) => (horizontal ? n.height : n.width));
  const heights = nodes.map((n) => (horizontal ? n.width : n.height));

  const reversed = greedyFas(nodes.length, pipelineEdges);
  const oriented = pipelineEdges.map(([u, v], i) => (reversed[i] ? ([v, u] as const) : ([u, v] as const)));
  const layer = assignLayers(nodes.length, oriented);
  const g = normalize(nodes.length, widths, heights, layer, oriented);
  const order = minimizeCrossings(g);
  const coords = assignCoords(g, order, { nodeGap, rankGap });

  const positions = new Map<string, Point>();
  nodes.forEach((n, i) => {
    const p = coords[i]!;
    const flow = mirrored ? -p.y : p.y;
    positions.set(n.id, horizontal ? { x: flow, y: p.x } : { x: p.x, y: flow });
  });
  return positions;
}
