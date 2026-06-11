import { Box } from '../math/Box';
import { Shape, ConnectorShape, isConnector } from '../shapes/Shape';
import { shapeRegistry } from '../shapes/ShapeRegistry';

/**
 * Incremental connector-reroute affected-set computation.
 *
 * On every document change the engine used to reroute *every* orthogonal
 * connector (O(connectors × shapes)). These helpers narrow that to the
 * connectors a given change can actually affect, so dragging one node reroutes
 * only the connectors touching it instead of the whole document.
 */

/**
 * Margin (world units) added around changed-shape bounds when deciding whether
 * a change can affect a connector's route. A conservative superset of the
 * router's own obstacle padding so the affected-set never misses a connector
 * that would genuinely reroute; an over-generous margin only costs a few
 * redundant reroutes, never a stale route.
 */
export const REROUTE_AFFECT_MARGIN = 32;

export interface ChangedShapes {
  /** Ids of every shape added, removed, or mutated since the previous state. */
  ids: Set<string>;
  /** Padded bounds (old and new) of changed NON-connector shapes — potential obstacles. */
  obstacleBoxes: Box[];
  /** Total number of changed shapes (drives the bulk-change fallback). */
  count: number;
}

function paddedBounds(shape: Shape): Box | null {
  try {
    const b = shapeRegistry.getHandler(shape.type).getBounds(shape);
    return new Box(
      b.minX - REROUTE_AFFECT_MARGIN,
      b.minY - REROUTE_AFFECT_MARGIN,
      b.maxX + REROUTE_AFFECT_MARGIN,
      b.maxY + REROUTE_AFFECT_MARGIN
    );
  } catch {
    return null;
  }
}

/**
 * Diff the previous and next shape maps to find what changed. Reference
 * equality is the change signal — Immer yields a fresh reference only for a
 * mutated slice. Both the old and the new bounds of a moved/resized shape are
 * recorded so a connector the obstacle moved *away from* (and should straighten)
 * is detected as well as one it moved *into*.
 */
export function collectChangedShapes(
  prev: Record<string, Shape>,
  next: Record<string, Shape>
): ChangedShapes {
  const ids = new Set<string>();
  const obstacleBoxes: Box[] = [];
  let count = 0;

  const note = (id: string, nextShape: Shape | undefined, prevShape: Shape | undefined): void => {
    ids.add(id);
    count++;
    for (const shape of [nextShape, prevShape]) {
      if (!shape || isConnector(shape)) continue; // connectors aren't obstacles
      const box = paddedBounds(shape);
      if (box) obstacleBoxes.push(box);
    }
  };

  for (const id in next) {
    if (next[id] !== prev[id]) note(id, next[id], prev[id]);
  }
  for (const id in prev) {
    if (!(id in next)) note(id, undefined, prev[id]);
  }

  return { ids, obstacleBoxes, count };
}

/**
 * Bounding box of a connector's current routed polyline
 * ([start, ...waypoints, end]).
 */
export function connectorRouteBox(connector: ConnectorShape): Box {
  let minX = Math.min(connector.x, connector.x2);
  let minY = Math.min(connector.y, connector.y2);
  let maxX = Math.max(connector.x, connector.x2);
  let maxY = Math.max(connector.y, connector.y2);
  for (const wp of connector.waypoints ?? []) {
    minX = Math.min(minX, wp.x);
    minY = Math.min(minY, wp.y);
    maxX = Math.max(maxX, wp.x);
    maxY = Math.max(maxY, wp.y);
  }
  return new Box(minX, minY, maxX, maxY);
}

/**
 * Whether a connector must be rerouted given a set of changed shapes. Affected when:
 *  - the connector shape itself changed (endpoint dragged, routing-mode toggled,
 *    freshly added), or
 *  - it is bound to a changed shape (a connected shape moved/resized), or
 *  - a changed shape's padded bounds intersect the connector's current route box
 *    (an obstacle moved into or out of its path).
 */
export function isConnectorAffected(connector: ConnectorShape, changed: ChangedShapes): boolean {
  if (changed.ids.has(connector.id)) return true;
  if (connector.startShapeId && changed.ids.has(connector.startShapeId)) return true;
  if (connector.endShapeId && changed.ids.has(connector.endShapeId)) return true;

  if (changed.obstacleBoxes.length > 0) {
    const routeBox = connectorRouteBox(connector);
    for (const box of changed.obstacleBoxes) {
      if (box.intersects(routeBox)) return true;
    }
  }
  return false;
}
