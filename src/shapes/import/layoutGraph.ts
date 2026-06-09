/**
 * Shared layered-graph layout for coordinate-less import adapters (JP-164 /
 * JP-85). Mermaid, PlantUML and friends describe a node/edge graph with no
 * geometry, so we assign positions here.
 *
 * This is the **light, editor-side** layout: longest-path layering (Sugiyama
 * without crossing minimisation) + per-rank packing using each node's real
 * size. It is deterministic (stable on re-run, tie-broken by input order) and
 * dependency-free — the heavyweight, crossing-minimised, obstacle-routed
 * version is the relay-side JP-245 work; this one just needs to produce a
 * readable diagram a human is happy to open and then tidy.
 *
 * Returns **centre** positions (DocuShark box shapes are centre-anchored).
 */

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

/**
 * Assign ranks by longest path from the roots. Cycles are bounded: the relax
 * loop runs at most `n` passes, so a back-edge can't spin forever — it just
 * settles at a finite rank.
 */
function assignRanks(
  ids: string[],
  edges: GraphLayoutEdge[],
  has: (id: string) => boolean
): Map<string, number> {
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const e of edges) {
      if (e.from === e.to || !has(e.from) || !has(e.to)) continue;
      const next = rank.get(e.from)! + 1;
      if (next > rank.get(e.to)!) {
        rank.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

export function layoutGraph(
  nodes: GraphLayoutNode[],
  edges: GraphLayoutEdge[],
  options: GraphLayoutOptions = {}
): Map<string, Point> {
  const direction = options.direction ?? 'TB';
  const nodeGap = options.nodeGap ?? 48;
  const rankGap = options.rankGap ?? 72;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ids = nodes.map((n) => n.id);
  const rank = assignRanks(ids, edges, (id) => byId.has(id));

  // Group nodes by rank, preserving input order within each rank.
  const ranks = new Map<number, GraphLayoutNode[]>();
  let maxRank = 0;
  for (const node of nodes) {
    const r = rank.get(node.id)!;
    maxRank = Math.max(maxRank, r);
    (ranks.get(r) ?? ranks.set(r, []).get(r)!).push(node);
  }

  const horizontal = direction === 'LR' || direction === 'RL';
  // Flow-axis size = the dimension ranks advance along; cross-axis = the other.
  const flowSize = (n: GraphLayoutNode) => (horizontal ? n.width : n.height);
  const crossSize = (n: GraphLayoutNode) => (horizontal ? n.height : n.width);

  const positions = new Map<string, Point>();

  // Walk ranks in flow order, accumulating the flow-axis offset by the tallest
  // node in each rank. BT/RL just reverse the rank order.
  const order: number[] = [];
  for (let r = 0; r <= maxRank; r++) order.push(r);
  if (direction === 'BT' || direction === 'RL') order.reverse();

  let flowCursor = 0;
  for (const r of order) {
    const rankNodes = ranks.get(r) ?? [];
    const rankExtent = rankNodes.reduce((m, n) => Math.max(m, flowSize(n)), 0);
    const flowCenter = flowCursor + rankExtent / 2;

    // Pack the rank along the cross axis, centred on 0.
    const totalCross =
      rankNodes.reduce((s, n) => s + crossSize(n), 0) + Math.max(0, rankNodes.length - 1) * nodeGap;
    let crossCursor = -totalCross / 2;
    for (const n of rankNodes) {
      const crossCenter = crossCursor + crossSize(n) / 2;
      positions.set(
        n.id,
        horizontal ? { x: flowCenter, y: crossCenter } : { x: crossCenter, y: flowCenter }
      );
      crossCursor += crossSize(n) + nodeGap;
    }

    flowCursor += rankExtent + rankGap;
  }

  return positions;
}
