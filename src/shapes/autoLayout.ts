/**
 * Auto-layout for a selection of shapes (JP-305 Slice D foundation).
 *
 * Reuses the shared Sugiyama pipeline (`layoutGraph`, the same engine the MCP
 * relay and diagram imports use) to tidy an arbitrary group of canvas shapes:
 * the selected non-connector shapes are the nodes, the connectors among them
 * are the edges. The result is anchored on the group's current centre, so the
 * diagram re-flows *in place* instead of jumping to the world origin.
 *
 * Pure: computes positions only. Applying them to the document (and rerouting
 * connectors) is the caller's job — see `documentStore.autoLayoutShapes`.
 */

import { type Shape, isConnector } from './Shape';
import { shapeRegistry } from './ShapeRegistry';
import { layoutGraph, type GraphDirection } from './import/layoutGraph';

export interface AutoLayoutOptions {
  /** Flow direction; defaults to top-to-bottom. */
  direction?: GraphDirection;
}

/**
 * Compute tidied **centre** positions for the layout-eligible shapes among
 * `ids`. Nodes are the selected, existing, non-connector shapes; edges are the
 * connectors whose both endpoints are in that node set (whether or not the
 * connector itself is in `ids`). Returns a map of node id → new `{x, y}`.
 *
 * Returns an empty map (a no-op) when there are fewer than two nodes — there's
 * nothing to arrange.
 */
export function computeAutoLayout(
  ids: string[],
  shapes: Record<string, Shape>,
  options: AutoLayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const nodes = ids
    .map((id) => shapes[id])
    .filter((s): s is Shape => s !== undefined && !isConnector(s));
  if (nodes.length < 2) return new Map();

  const nodeIds = new Set(nodes.map((n) => n.id));

  const edges: Array<{ from: string; to: string }> = [];
  for (const shape of Object.values(shapes)) {
    if (!isConnector(shape)) continue;
    const a = shape.startShapeId;
    const b = shape.endShapeId;
    if (a && b && nodeIds.has(a) && nodeIds.has(b)) edges.push({ from: a, to: b });
  }

  const layoutNodes = nodes.map((n) => {
    const b = shapeRegistry.getHandler(n.type).getBounds(n);
    return { id: n.id, width: b.width, height: b.height };
  });

  const laid = layoutGraph(layoutNodes, edges, options);

  // Anchor: keep the group's current centre fixed (re-flow in place). Both
  // centres are the midpoint of the node-centre spread; node x/y is the centre
  // for box shapes, matching what layoutGraph emits.
  const current = spreadCenter(nodes.map((n) => ({ x: n.x, y: n.y })));
  const next = spreadCenter([...laid.values()]);
  const dx = current.x - next.x;
  const dy = current.y - next.y;

  const out = new Map<string, { x: number; y: number }>();
  for (const [id, p] of laid) out.set(id, { x: p.x + dx, y: p.y + dy });
  return out;
}

/** Midpoint of the min/max spread of a set of points. */
function spreadCenter(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}
