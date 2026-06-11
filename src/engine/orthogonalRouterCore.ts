import { Vec2 } from '../math/Vec2';
import { Box } from '../math/Box';

/**
 * Deterministic orthogonal obstacle router (JP-167 Tier 2).
 *
 * When the simple anchor-directed candidates all hit an obstacle, route the
 * connector through a sparse orthogonal visibility graph with an A* search that
 * minimises path length plus a per-bend penalty. The whole core runs on grid
 * coordinates with no transcendental functions and a fixed tie-break order, so
 * a given input always yields the same route — stable under small endpoint
 * moves, and portable enough that the relay-side router (JP-245) can mirror it.
 *
 * Pure module: no canvas, store, or shape-registry access.
 */

/** Clearance placed just outside each obstacle so a route can hug it without
 * the segment-clear test rejecting an edge-grazing path. */
const CLEARANCE = 1;

/** Cost added whenever the route changes direction. Biases toward few bends. */
const BEND_COST = 20;

/** Above this obstacle count the visibility graph is too large to build cheaply
 * per frame; callers should fall back to the simple nudge heuristic. */
export const MAX_OVG_OBSTACLES = 40;

type Pt = { x: number; y: number };

// Absolute directions, indexed: 0=+x, 1=-x, 2=+y, 3=-y (screen space, y down).
const DIRS: ReadonlyArray<Pt> = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

function dirIndexOf(v: Vec2): number {
  if (Math.abs(v.x) >= Math.abs(v.y)) return v.x >= 0 ? 0 : 1;
  return v.y >= 0 ? 2 : 3;
}

/**
 * Candidate move directions given the arrival direction, ordered
 * straight → right → left → reverse. The fixed order makes equal-cost routes
 * resolve identically (the determinism the jitter-free behaviour relies on).
 */
function orderedMoves(arrivalDir: number): readonly number[] {
  switch (arrivalDir) {
    case 0:
      return [0, 2, 3, 1]; // +x: straight +x, right +y, left -y, reverse -x
    case 1:
      return [1, 3, 2, 0]; // -x
    case 2:
      return [2, 1, 0, 3]; // +y
    case 3:
      return [3, 0, 1, 2]; // -y
    default:
      return [0, 1, 2, 3];
  }
}

/** Whether an axis-aligned segment crosses a box's interior (edge-grazing is clear). */
function segmentCrossesBox(x1: number, y1: number, x2: number, y2: number, o: Box): boolean {
  if (y1 === y2) {
    const y = y1;
    if (y <= o.minY || y >= o.maxY) return false;
    const lo = Math.min(x1, x2);
    const hi = Math.max(x1, x2);
    return hi > o.minX && lo < o.maxX;
  }
  const x = x1;
  if (x <= o.minX || x >= o.maxX) return false;
  const lo = Math.min(y1, y2);
  const hi = Math.max(y1, y2);
  return hi > o.minY && lo < o.maxY;
}

interface HeapNode {
  xi: number;
  yi: number;
  dir: number;
  g: number;
  f: number;
  seq: number;
}

/** Minimal binary min-heap ordered by (f, seq) — seq gives a stable tie-break. */
class NodeHeap {
  private items: HeapNode[] = [];

  get size(): number {
    return this.items.length;
  }

  private less(a: HeapNode, b: HeapNode): boolean {
    return a.f < b.f || (a.f === b.f && a.seq < b.seq);
  }

  push(node: HeapNode): void {
    const items = this.items;
    items.push(node);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(items[i]!, items[parent]!)) {
        [items[i], items[parent]] = [items[parent]!, items[i]!];
        i = parent;
      } else break;
    }
  }

  pop(): HeapNode | undefined {
    const items = this.items;
    const top = items[0];
    if (top === undefined) return undefined;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < items.length && this.less(items[l]!, items[smallest]!)) smallest = l;
        if (r < items.length && this.less(items[r]!, items[smallest]!)) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest]!, items[i]!];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Route an orthogonal connector from `start` to `end` around `obstacles`,
 * preferring to leave `start` in `startDir`. Returns the interior waypoints
 * (excluding the endpoints), or `null` when there are no obstacles, the graph
 * is too large, or no route exists — in which case the caller should fall back.
 *
 * `obstacles` are expected pre-padded (and ideally corridor-restricted). The
 * connected start/end shapes must NOT be included — the route exits/enters them
 * at the endpoints, and endpoint clipping trims the visual.
 */
export function routeOrthogonalAvoiding(
  start: Vec2,
  end: Vec2,
  startDir: Vec2,
  obstacles: Box[]
): Pt[] | null {
  if (obstacles.length === 0 || obstacles.length > MAX_OVG_OBSTACLES) return null;

  // Gridlines: the endpoints plus each obstacle edge nudged out by the clearance.
  const xsSet = new Set<number>([start.x, end.x]);
  const ysSet = new Set<number>([start.y, end.y]);
  for (const o of obstacles) {
    xsSet.add(o.minX - CLEARANCE);
    xsSet.add(o.maxX + CLEARANCE);
    ysSet.add(o.minY - CLEARANCE);
    ysSet.add(o.maxY + CLEARANCE);
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  const nx = xs.length;
  const ny = ys.length;

  const startXi = xs.indexOf(start.x);
  const startYi = ys.indexOf(start.y);
  const endXi = xs.indexOf(end.x);
  const endYi = ys.indexOf(end.y);
  if (startXi < 0 || startYi < 0 || endXi < 0 || endYi < 0) return null;

  const blocked = (xi: number, yi: number): boolean => {
    const px = xs[xi]!;
    const py = ys[yi]!;
    for (const o of obstacles) {
      if (px > o.minX && px < o.maxX && py > o.minY && py < o.maxY) return true;
    }
    return false;
  };
  if (blocked(startXi, startYi) || blocked(endXi, endYi)) return null;

  const clear = (x1: number, y1: number, x2: number, y2: number): boolean => {
    for (const o of obstacles) {
      if (segmentCrossesBox(x1, y1, x2, y2, o)) return false;
    }
    return true;
  };

  const keyOf = (xi: number, yi: number, dir: number): number => (yi * nx + xi) * 4 + dir;
  const heuristic = (xi: number, yi: number): number =>
    Math.abs(xs[xi]! - xs[endXi]!) + Math.abs(ys[yi]! - ys[endYi]!);

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const heap = new NodeHeap();
  let seq = 0;

  const startDirIdx = dirIndexOf(startDir);
  const startKey = keyOf(startXi, startYi, startDirIdx);
  gScore.set(startKey, 0);
  heap.push({ xi: startXi, yi: startYi, dir: startDirIdx, g: 0, f: heuristic(startXi, startYi), seq: seq++ });

  let goalKey = -1;
  while (heap.size > 0) {
    const cur = heap.pop()!;
    const curKey = keyOf(cur.xi, cur.yi, cur.dir);
    if (cur.g > (gScore.get(curKey) ?? Infinity)) continue; // stale heap entry
    if (cur.xi === endXi && cur.yi === endYi) {
      goalKey = curKey;
      break;
    }

    for (const moveDir of orderedMoves(cur.dir)) {
      const d = DIRS[moveDir]!;
      const nxi = cur.xi + (d.x > 0 ? 1 : d.x < 0 ? -1 : 0);
      const nyi = cur.yi + (d.y > 0 ? 1 : d.y < 0 ? -1 : 0);
      if (nxi < 0 || nxi >= nx || nyi < 0 || nyi >= ny) continue;
      if (blocked(nxi, nyi)) continue;
      if (!clear(xs[cur.xi]!, ys[cur.yi]!, xs[nxi]!, ys[nyi]!)) continue;

      const segLen = Math.abs(xs[nxi]! - xs[cur.xi]!) + Math.abs(ys[nyi]! - ys[cur.yi]!);
      const bend = moveDir === cur.dir ? 0 : BEND_COST;
      const ng = cur.g + segLen + bend;
      const nKey = keyOf(nxi, nyi, moveDir);
      if (ng < (gScore.get(nKey) ?? Infinity)) {
        gScore.set(nKey, ng);
        cameFrom.set(nKey, curKey);
        heap.push({ xi: nxi, yi: nyi, dir: moveDir, g: ng, f: ng + heuristic(nxi, nyi), seq: seq++ });
      }
    }
  }

  if (goalKey < 0) return null;

  // Reconstruct start → end, then drop collinear points and the endpoints.
  const pts: Pt[] = [];
  let k: number | undefined = goalKey;
  while (k !== undefined) {
    const dir = k % 4;
    const rest = (k - dir) / 4;
    const xi = rest % nx;
    const yi = (rest - xi) / nx;
    pts.push({ x: xs[xi]!, y: ys[yi]! });
    k = cameFrom.get(k);
  }
  pts.reverse();

  const simplified = simplifyCollinear(pts);
  return simplified.slice(1, Math.max(1, simplified.length - 1));
}

/** Remove collinear interior points from an orthogonal point list. */
function simplifyCollinear(points: Pt[]): Pt[] {
  if (points.length <= 2) return points;
  const out: Pt[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1]!;
    const curr = points[i]!;
    const next = points[i + 1]!;
    const sameX = prev.x === curr.x && curr.x === next.x;
    const sameY = prev.y === curr.y && curr.y === next.y;
    if (!sameX && !sameY) out.push(curr);
  }
  out.push(points[points.length - 1]!);
  return out;
}
