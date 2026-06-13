/**
 * Shape connectivity — treats the canvas as a graph where connectors are edges
 * between the shapes they bind (`startShapeId`/`endShapeId`). The foundation
 * for "select the whole chain" from any shape and for scoping auto-layout to a
 * connected group (JP-305 Slice D).
 *
 * Pure: no store, engine, or registry access.
 */

import { type Shape, isConnector } from './Shape';

/**
 * Every shape id reachable from `seedIds` through connectors — the union of the
 * connected components containing the seeds, including the seed shapes and the
 * connectors that wire the component together.
 *
 * - A connector counts as connected to both endpoints it actually binds; a
 *   dangling endpoint (null, or a shape that no longer exists) contributes
 *   nothing.
 * - Seeding on a connector starts traversal from its endpoints.
 * - Ids in `seedIds` that don't exist in `shapes` are skipped.
 *
 * The result is unordered (a set, returned as an array). Callers that need a
 * stable order should sort, but selection doesn't care.
 */
export function findConnectedShapes(
  seedIds: Iterable<string>,
  shapes: Record<string, Shape>,
): string[] {
  // node id -> linked node ids (via any binding connector)
  const neighbors = new Map<string, Set<string>>();
  // node id -> connector ids touching it
  const incident = new Map<string, string[]>();

  const link = (a: string, b: string): void => {
    (neighbors.get(a) ?? neighbors.set(a, new Set()).get(a)!).add(b);
  };
  const touch = (nodeId: string, connId: string): void => {
    (incident.get(nodeId) ?? incident.set(nodeId, []).get(nodeId)!).push(connId);
  };

  for (const shape of Object.values(shapes)) {
    if (!isConnector(shape)) continue;
    const a = shape.startShapeId && shapes[shape.startShapeId] ? shape.startShapeId : null;
    const b = shape.endShapeId && shapes[shape.endShapeId] ? shape.endShapeId : null;
    if (a) touch(a, shape.id);
    if (b) touch(b, shape.id);
    if (a && b && a !== b) {
      link(a, b);
      link(b, a);
    }
  }

  const result = new Set<string>();
  const queue: string[] = [];
  const enqueueNode = (id: string): void => {
    if (!result.has(id)) {
      result.add(id);
      queue.push(id);
    }
  };

  for (const id of seedIds) {
    const seed = shapes[id];
    if (!seed) continue;
    if (isConnector(seed)) {
      // Include the seed connector and traverse from its bound endpoints.
      result.add(id);
      if (seed.startShapeId && shapes[seed.startShapeId]) enqueueNode(seed.startShapeId);
      if (seed.endShapeId && shapes[seed.endShapeId]) enqueueNode(seed.endShapeId);
    } else {
      enqueueNode(id);
    }
  }

  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const connId of incident.get(cur) ?? []) result.add(connId);
    for (const nb of neighbors.get(cur) ?? []) enqueueNode(nb);
  }

  return [...result];
}
