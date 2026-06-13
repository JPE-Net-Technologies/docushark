//! Deterministic orthogonal connector routing (JP-245).
//!
//! A faithful Rust port of the editor's router so relay-emitted waypoints
//! agree with what the editor computes when it re-routes after a node move:
//!
//! - Tier 1/fallbacks: `calculateOrthogonalPath` in
//!   `src/engine/OrthogonalRouter.ts` (anchor-directed candidates, shortest
//!   clear candidate, combined-bounds nudge).
//! - Tier 2: `routeOrthogonalAvoiding` in
//!   `src/engine/orthogonalRouterCore.ts` (orthogonal visibility graph + A*).
//!
//! Constants, tie-break orders, and arithmetic mirror the TypeScript
//! line-for-line; both sides are IEEE doubles, so identical inputs produce
//! identical waypoints (pinned by cross-language parity tests below).
//! **Changes here must be mirrored in the TS router and vice versa.**

use super::layout::Pos;

/// Minimum distance to extend from an anchor before turning.
const MIN_STUB_LENGTH: f64 = 20.0;
/// Padding around shapes for obstacle avoidance.
pub const OBSTACLE_PADDING: f64 = 15.0;
/// Padding around the two connected endpoint shapes (just enough to detect
/// a route cutting back through them).
pub const CONNECTED_SHAPE_PADDING: f64 = 2.0;
/// Clearance placed just outside each obstacle so a route can hug it without
/// the segment-clear test rejecting an edge-grazing path.
const CLEARANCE: f64 = 1.0;
/// Cost added whenever the route changes direction. Biases toward few bends.
const BEND_COST: f64 = 20.0;
/// Above this obstacle count the visibility graph is too large to build;
/// the caller falls back to the nudge heuristic.
pub const MAX_OVG_OBSTACLES: usize = 40;
/// Corridor expansion when collecting per-edge obstacles: the farthest a
/// candidate path bends out from an endpoint (the stub) plus the obstacle
/// padding, so an obstacle whose padded box just reaches a corridor-edge
/// segment is still included. Matches the editor's spatial-index corridor.
pub const CORRIDOR_PADDING: f64 = MIN_STUB_LENGTH + OBSTACLE_PADDING;

/// Axis-aligned obstacle box in world space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Rect {
    pub fn expand(&self, by: f64) -> Rect {
        Rect {
            min_x: self.min_x - by,
            min_y: self.min_y - by,
            max_x: self.max_x + by,
            max_y: self.max_y + by,
        }
    }

    pub fn intersects(&self, other: &Rect) -> bool {
        self.min_x <= other.max_x
            && self.max_x >= other.min_x
            && self.min_y <= other.max_y
            && self.max_y >= other.min_y
    }
}

/// Bounding box of two points.
pub fn bbox(a: Pos, b: Pos) -> Rect {
    Rect {
        min_x: a.x.min(b.x),
        min_y: a.y.min(b.y),
        max_x: a.x.max(b.x),
        max_y: a.y.max(b.y),
    }
}

/// Route an orthogonal connector from `start` to `end`, preferring to leave
/// in `start_dir` and enter against `end_dir` (anchor exit directions; a zero
/// vector means "infer from the relative position", the center-anchor case).
/// Returns interior waypoints (endpoints excluded). Mirrors the editor's
/// `calculateOrthogonalPath` tiering:
///
/// 1. the canonical anchor-directed candidate when obstacle-free (stable as
///    endpoints move — no flip-flopping between similar-length routes),
/// 2. else the shortest obstacle-free of the simple candidates,
/// 3. else visibility-graph + A* ([`route_avoiding`]),
/// 4. else the combined-bounds nudge heuristic.
///
/// `obstacles` are pre-padded boxes excluding the connected endpoint shapes;
/// `connected` holds those two shapes (lightly padded) — exit/entry segments
/// may touch them, middle segments may not.
pub fn route_orthogonal(
    start: Pos,
    end: Pos,
    start_dir: (f64, f64),
    end_dir: (f64, f64),
    obstacles: &[Rect],
    connected: &[Rect],
) -> Vec<Pos> {
    let start_dir = resolve_dir(start_dir, start, end);
    let end_dir = resolve_dir(end_dir, end, start);

    let start_stub = Pos {
        x: start.x + start_dir.0 * MIN_STUB_LENGTH,
        y: start.y + start_dir.1 * MIN_STUB_LENGTH,
    };
    let end_stub = Pos {
        x: end.x + end_dir.0 * MIN_STUB_LENGTH,
        y: end.y + end_dir.1 * MIN_STUB_LENGTH,
    };
    let start_horizontal = start_dir.0.abs() > start_dir.1.abs();
    let end_horizontal = end_dir.0.abs() > end_dir.1.abs();

    let candidates = generate_candidates(start_stub, end_stub, start_horizontal, end_horizontal);

    // Tier 1: the canonical anchor-directed route whenever it is clear.
    let canonical = simplify_path(&candidates[0]);
    if is_route_valid(start, &canonical, end, obstacles, connected) {
        return canonical;
    }

    // Shortest clear simple candidate.
    let mut best_path = candidates[0].clone();
    let mut best_length = f64::INFINITY;
    for candidate in &candidates {
        let simplified = simplify_path(candidate);
        if !is_route_valid(start, &simplified, end, obstacles, connected) {
            continue;
        }
        let length = path_length(start, &simplified, end);
        if length < best_length {
            best_length = length;
            best_path = simplified;
        }
    }

    // Tier 2: visibility graph + A*; nudge heuristic as the last resort.
    if best_length.is_infinite() && !obstacles.is_empty() {
        best_path = route_avoiding(start, end, start_dir, obstacles)
            .unwrap_or_else(|| avoid_obstacles(start, end, simplify_path(&candidates[0]), obstacles));
    }

    best_path
}

fn resolve_dir(dir: (f64, f64), from: Pos, to: Pos) -> (f64, f64) {
    if dir.0 == 0.0 && dir.1 == 0.0 {
        infer_direction(from, to)
    } else {
        dir
    }
}

/// Prefer horizontal when |dx| is larger, vertical otherwise.
fn infer_direction(from: Pos, to: Pos) -> (f64, f64) {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    if dx.abs() > dy.abs() {
        if dx > 0.0 {
            (1.0, 0.0)
        } else {
            (-1.0, 0.0)
        }
    } else if dy > 0.0 {
        (0.0, 1.0)
    } else {
        (0.0, -1.0)
    }
}

/// Candidate waypoint lists between the stub points (start/end excluded).
/// Order matters: index 0 is the canonical anchor-directed route.
fn generate_candidates(
    start_stub: Pos,
    end_stub: Pos,
    start_horizontal: bool,
    end_horizontal: bool,
) -> Vec<Vec<Pos>> {
    let mut candidates: Vec<Vec<Pos>> = Vec::new();

    // Strategy 1: anchor-directed stubs joined by an L (mixed orientation)
    // or Z (same orientation) path.
    if start_horizontal == end_horizontal {
        let middle = if start_horizontal {
            let mid_x = (start_stub.x + end_stub.x) / 2.0;
            vec![Pos { x: mid_x, y: start_stub.y }, Pos { x: mid_x, y: end_stub.y }]
        } else {
            let mid_y = (start_stub.y + end_stub.y) / 2.0;
            vec![Pos { x: start_stub.x, y: mid_y }, Pos { x: end_stub.x, y: mid_y }]
        };
        let mut path = vec![start_stub];
        path.extend(middle);
        path.push(end_stub);
        candidates.push(path);
    } else {
        let corner = if start_horizontal {
            Pos { x: end_stub.x, y: start_stub.y }
        } else {
            Pos { x: start_stub.x, y: end_stub.y }
        };
        candidates.push(vec![start_stub, corner, end_stub]);
    }

    // Strategy 2: Z-path with a vertical middle segment at the midpoint x.
    let mid_x = (start_stub.x + end_stub.x) / 2.0;
    candidates.push(vec![
        start_stub,
        Pos { x: mid_x, y: start_stub.y },
        Pos { x: mid_x, y: end_stub.y },
        end_stub,
    ]);

    // Strategy 3: Z-path with a horizontal middle segment at the midpoint y.
    let mid_y = (start_stub.y + end_stub.y) / 2.0;
    candidates.push(vec![
        start_stub,
        Pos { x: start_stub.x, y: mid_y },
        Pos { x: end_stub.x, y: mid_y },
        end_stub,
    ]);

    // Strategies 4 + 5: the two L-path corners.
    candidates.push(vec![start_stub, Pos { x: end_stub.x, y: start_stub.y }, end_stub]);
    candidates.push(vec![start_stub, Pos { x: start_stub.x, y: end_stub.y }, end_stub]);

    // Strategy 6: direct connection when the stubs are already in line.
    if (end_stub.x - start_stub.x).abs() < 1.0 {
        candidates.push(vec![start_stub, Pos { x: start_stub.x, y: end_stub.y }]);
    }
    if (end_stub.y - start_stub.y).abs() < 1.0 {
        candidates.push(vec![start_stub, Pos { x: end_stub.x, y: start_stub.y }]);
    }

    candidates
}

/// Drop collinear interior points (corners only survive).
fn simplify_path(waypoints: &[Pos]) -> Vec<Pos> {
    if waypoints.len() <= 2 {
        return waypoints.to_vec();
    }
    let mut result = vec![waypoints[0]];
    for i in 1..waypoints.len() - 1 {
        let prev = result[result.len() - 1];
        let curr = waypoints[i];
        let next = waypoints[i + 1];
        let same_x = prev.x == curr.x && curr.x == next.x;
        let same_y = prev.y == curr.y && curr.y == next.y;
        if !same_x && !same_y {
            result.push(curr);
        }
    }
    result.push(waypoints[waypoints.len() - 1]);
    result
}

/// Whether a route is free of obstacle intersections. Exit/entry segments
/// leave/enter the connected shapes, so they are only tested against regular
/// obstacles; middle segments also avoid the connected shapes themselves.
fn is_route_valid(
    start: Pos,
    waypoints: &[Pos],
    end: Pos,
    obstacles: &[Rect],
    connected: &[Rect],
) -> bool {
    let full = full_path(start, waypoints, end);
    for i in 0..full.len() - 1 {
        let is_exit = i == 0;
        let is_entry = i == full.len() - 2;
        if segment_intersects_obstacles(full[i], full[i + 1], obstacles) {
            return false;
        }
        if !is_exit && !is_entry && segment_intersects_obstacles(full[i], full[i + 1], connected) {
            return false;
        }
    }
    true
}

fn full_path(start: Pos, waypoints: &[Pos], end: Pos) -> Vec<Pos> {
    let mut full = Vec::with_capacity(waypoints.len() + 2);
    full.push(start);
    full.extend_from_slice(waypoints);
    full.push(end);
    full
}

fn path_length(start: Pos, waypoints: &[Pos], end: Pos) -> f64 {
    let full = full_path(start, waypoints, end);
    let mut length = 0.0;
    for i in 0..full.len() - 1 {
        let dx = full[i + 1].x - full[i].x;
        let dy = full[i + 1].y - full[i].y;
        length += (dx * dx + dy * dy).sqrt();
    }
    length
}

fn segment_intersects_obstacles(p1: Pos, p2: Pos, obstacles: &[Rect]) -> bool {
    obstacles.iter().any(|o| line_intersects_box(p1, p2, o))
}

/// Liang–Barsky segment/box test (boundary contact counts as intersecting —
/// these boxes are pre-padded, so touching the pad is already too close).
fn line_intersects_box(p1: Pos, p2: Pos, b: &Rect) -> bool {
    let dx = p2.x - p1.x;
    let dy = p2.y - p1.y;
    let mut t_min = 0.0f64;
    let mut t_max = 1.0f64;

    if dx != 0.0 {
        let t1 = (b.min_x - p1.x) / dx;
        let t2 = (b.max_x - p1.x) / dx;
        if dx > 0.0 {
            t_min = t_min.max(t1);
            t_max = t_max.min(t2);
        } else {
            t_min = t_min.max(t2);
            t_max = t_max.min(t1);
        }
    } else if p1.x < b.min_x || p1.x > b.max_x {
        return false;
    }

    if dy != 0.0 {
        let t1 = (b.min_y - p1.y) / dy;
        let t2 = (b.max_y - p1.y) / dy;
        if dy > 0.0 {
            t_min = t_min.max(t1);
            t_max = t_max.min(t2);
        } else {
            t_min = t_min.max(t2);
            t_max = t_max.min(t1);
        }
    } else if p1.y < b.min_y || p1.y > b.max_y {
        return false;
    }

    t_min <= t_max
}

/// Last-resort nudge: route the whole path around the combined bounds of the
/// intersecting obstacles, picking the shortest clear detour of the four
/// sides (above/below/left/right, first wins ties).
fn avoid_obstacles(start: Pos, end: Pos, waypoints: Vec<Pos>, obstacles: &[Rect]) -> Vec<Pos> {
    if obstacles.is_empty() {
        return waypoints;
    }
    let full = full_path(start, &waypoints, end);
    let mut has_intersection = false;
    for i in 0..full.len() - 1 {
        if segment_intersects_obstacles(full[i], full[i + 1], obstacles) {
            has_intersection = true;
            break;
        }
    }
    if !has_intersection {
        return waypoints;
    }

    let mut combined: Option<Rect> = None;
    for o in obstacles {
        for i in 0..full.len() - 1 {
            if line_intersects_box(full[i], full[i + 1], o) {
                combined = Some(match combined {
                    None => *o,
                    Some(c) => Rect {
                        min_x: c.min_x.min(o.min_x),
                        min_y: c.min_y.min(o.min_y),
                        max_x: c.max_x.max(o.max_x),
                        max_y: c.max_y.max(o.max_y),
                    },
                });
            }
        }
    }
    let Some(bounds) = combined else {
        return waypoints;
    };

    let routes = [
        vec![
            Pos { x: start.x, y: bounds.min_y - OBSTACLE_PADDING },
            Pos { x: end.x, y: bounds.min_y - OBSTACLE_PADDING },
        ],
        vec![
            Pos { x: start.x, y: bounds.max_y + OBSTACLE_PADDING },
            Pos { x: end.x, y: bounds.max_y + OBSTACLE_PADDING },
        ],
        vec![
            Pos { x: bounds.min_x - OBSTACLE_PADDING, y: start.y },
            Pos { x: bounds.min_x - OBSTACLE_PADDING, y: end.y },
        ],
        vec![
            Pos { x: bounds.max_x + OBSTACLE_PADDING, y: start.y },
            Pos { x: bounds.max_x + OBSTACLE_PADDING, y: end.y },
        ],
    ];

    let mut best_route = waypoints;
    let mut best_length = f64::INFINITY;
    for route in routes {
        let test = full_path(start, &route, end);
        let mut valid = true;
        for i in 0..test.len() - 1 {
            if segment_intersects_obstacles(test[i], test[i + 1], obstacles) {
                valid = false;
                break;
            }
        }
        if valid {
            let length = path_length(start, &route, end);
            if length < best_length {
                best_length = length;
                best_route = route;
            }
        }
    }
    best_route
}

// ---------------------------------------------------------------------------
// Tier 2: orthogonal visibility graph + A*
// (port of src/engine/orthogonalRouterCore.ts)
// ---------------------------------------------------------------------------

// Absolute directions, indexed: 0=+x, 1=-x, 2=+y, 3=-y (screen space, y down).
const DIRS: [(f64, f64); 4] = [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)];

fn dir_index_of(v: (f64, f64)) -> usize {
    if v.0.abs() >= v.1.abs() {
        if v.0 >= 0.0 {
            0
        } else {
            1
        }
    } else if v.1 >= 0.0 {
        2
    } else {
        3
    }
}

/// Candidate move directions given the arrival direction, ordered
/// straight -> right -> left -> reverse. The fixed order makes equal-cost
/// routes resolve identically.
fn ordered_moves(arrival_dir: usize) -> [usize; 4] {
    match arrival_dir {
        0 => [0, 2, 3, 1], // +x: straight +x, right +y, left -y, reverse -x
        1 => [1, 3, 2, 0], // -x
        2 => [2, 1, 0, 3], // +y
        3 => [3, 0, 1, 2], // -y
        _ => [0, 1, 2, 3],
    }
}

/// Whether an axis-aligned segment crosses a box's interior (edge-grazing is
/// clear — this is the OVG's hug-the-clearance test, deliberately different
/// from [`line_intersects_box`]). `pub(crate)` so integration tests can
/// assert routed paths stay clear of node interiors.
pub(crate) fn segment_crosses_box(x1: f64, y1: f64, x2: f64, y2: f64, o: &Rect) -> bool {
    if y1 == y2 {
        let y = y1;
        if y <= o.min_y || y >= o.max_y {
            return false;
        }
        let lo = x1.min(x2);
        let hi = x1.max(x2);
        return hi > o.min_x && lo < o.max_x;
    }
    let x = x1;
    if x <= o.min_x || x >= o.max_x {
        return false;
    }
    let lo = y1.min(y2);
    let hi = y1.max(y2);
    hi > o.min_y && lo < o.max_y
}

#[derive(Clone, Copy)]
struct HeapNode {
    xi: usize,
    yi: usize,
    dir: usize,
    g: f64,
    f: f64,
    seq: u64,
}

/// Minimal binary min-heap ordered by (f, seq) — seq gives a stable tie-break.
struct NodeHeap {
    items: Vec<HeapNode>,
}

impl NodeHeap {
    fn new() -> Self {
        NodeHeap { items: Vec::new() }
    }

    fn less(a: &HeapNode, b: &HeapNode) -> bool {
        a.f < b.f || (a.f == b.f && a.seq < b.seq)
    }

    fn push(&mut self, node: HeapNode) {
        let items = &mut self.items;
        items.push(node);
        let mut i = items.len() - 1;
        while i > 0 {
            let parent = (i - 1) >> 1;
            if Self::less(&items[i], &items[parent]) {
                items.swap(i, parent);
                i = parent;
            } else {
                break;
            }
        }
    }

    fn pop(&mut self) -> Option<HeapNode> {
        let items = &mut self.items;
        if items.is_empty() {
            return None;
        }
        let top = items[0];
        let last = items.pop().expect("non-empty");
        if !items.is_empty() {
            items[0] = last;
            let mut i = 0;
            loop {
                let l = 2 * i + 1;
                let r = 2 * i + 2;
                let mut smallest = i;
                if l < items.len() && Self::less(&items[l], &items[smallest]) {
                    smallest = l;
                }
                if r < items.len() && Self::less(&items[r], &items[smallest]) {
                    smallest = r;
                }
                if smallest == i {
                    break;
                }
                items.swap(i, smallest);
                i = smallest;
            }
        }
        Some(top)
    }
}

/// Route from `start` to `end` around `obstacles` through a sparse orthogonal
/// visibility graph with an A* search minimizing path length plus a per-bend
/// penalty, preferring to leave `start` in `start_dir`. Returns the interior
/// waypoints, or `None` when there are no obstacles, the graph is too large,
/// or no route exists — the caller falls back. Obstacles are expected
/// pre-padded and must NOT include the connected endpoint shapes.
pub fn route_avoiding(
    start: Pos,
    end: Pos,
    start_dir: (f64, f64),
    obstacles: &[Rect],
) -> Option<Vec<Pos>> {
    if obstacles.is_empty() || obstacles.len() > MAX_OVG_OBSTACLES {
        return None;
    }

    // Gridlines: the endpoints plus each obstacle edge nudged out by the
    // clearance (deduplicated, sorted).
    let mut xs: Vec<f64> = vec![start.x, end.x];
    let mut ys: Vec<f64> = vec![start.y, end.y];
    for o in obstacles {
        xs.push(o.min_x - CLEARANCE);
        xs.push(o.max_x + CLEARANCE);
        ys.push(o.min_y - CLEARANCE);
        ys.push(o.max_y + CLEARANCE);
    }
    xs.sort_by(|a, b| a.partial_cmp(b).expect("finite coordinate"));
    xs.dedup();
    ys.sort_by(|a, b| a.partial_cmp(b).expect("finite coordinate"));
    ys.dedup();
    let nx = xs.len();
    let ny = ys.len();

    let index_of = |v: f64, axis: &[f64]| -> Option<usize> {
        axis.binary_search_by(|p| p.partial_cmp(&v).expect("finite coordinate")).ok()
    };
    let start_xi = index_of(start.x, &xs)?;
    let start_yi = index_of(start.y, &ys)?;
    let end_xi = index_of(end.x, &xs)?;
    let end_yi = index_of(end.y, &ys)?;

    let blocked = |xi: usize, yi: usize| -> bool {
        let px = xs[xi];
        let py = ys[yi];
        obstacles
            .iter()
            .any(|o| px > o.min_x && px < o.max_x && py > o.min_y && py < o.max_y)
    };
    if blocked(start_xi, start_yi) || blocked(end_xi, end_yi) {
        return None;
    }

    let clear = |x1: f64, y1: f64, x2: f64, y2: f64| -> bool {
        !obstacles.iter().any(|o| segment_crosses_box(x1, y1, x2, y2, o))
    };

    let key_of = |xi: usize, yi: usize, dir: usize| -> usize { (yi * nx + xi) * 4 + dir };
    let heuristic =
        |xi: usize, yi: usize| -> f64 { (xs[xi] - xs[end_xi]).abs() + (ys[yi] - ys[end_yi]).abs() };

    let n_states = nx * ny * 4;
    let mut g_score = vec![f64::INFINITY; n_states];
    let mut came_from = vec![usize::MAX; n_states];
    let mut heap = NodeHeap::new();
    let mut seq: u64 = 0;

    let start_dir_idx = dir_index_of(start_dir);
    let start_key = key_of(start_xi, start_yi, start_dir_idx);
    g_score[start_key] = 0.0;
    heap.push(HeapNode {
        xi: start_xi,
        yi: start_yi,
        dir: start_dir_idx,
        g: 0.0,
        f: heuristic(start_xi, start_yi),
        seq,
    });
    seq += 1;

    let mut goal_key = usize::MAX;
    while let Some(cur) = heap.pop() {
        let cur_key = key_of(cur.xi, cur.yi, cur.dir);
        if cur.g > g_score[cur_key] {
            continue; // stale heap entry
        }
        if cur.xi == end_xi && cur.yi == end_yi {
            goal_key = cur_key;
            break;
        }

        for move_dir in ordered_moves(cur.dir) {
            let d = DIRS[move_dir];
            let nxi = if d.0 > 0.0 {
                cur.xi + 1
            } else if d.0 < 0.0 {
                match cur.xi.checked_sub(1) {
                    Some(v) => v,
                    None => continue,
                }
            } else {
                cur.xi
            };
            let nyi = if d.1 > 0.0 {
                cur.yi + 1
            } else if d.1 < 0.0 {
                match cur.yi.checked_sub(1) {
                    Some(v) => v,
                    None => continue,
                }
            } else {
                cur.yi
            };
            if nxi >= nx || nyi >= ny {
                continue;
            }
            if blocked(nxi, nyi) {
                continue;
            }
            if !clear(xs[cur.xi], ys[cur.yi], xs[nxi], ys[nyi]) {
                continue;
            }

            let seg_len = (xs[nxi] - xs[cur.xi]).abs() + (ys[nyi] - ys[cur.yi]).abs();
            let bend = if move_dir == cur.dir { 0.0 } else { BEND_COST };
            let ng = cur.g + seg_len + bend;
            let n_key = key_of(nxi, nyi, move_dir);
            if ng < g_score[n_key] {
                g_score[n_key] = ng;
                came_from[n_key] = cur_key;
                heap.push(HeapNode {
                    xi: nxi,
                    yi: nyi,
                    dir: move_dir,
                    g: ng,
                    f: ng + heuristic(nxi, nyi),
                    seq,
                });
                seq += 1;
            }
        }
    }

    if goal_key == usize::MAX {
        return None;
    }

    // Reconstruct start -> end, then drop collinear points and the endpoints.
    let mut pts: Vec<Pos> = Vec::new();
    let mut k = goal_key;
    loop {
        let rest = k / 4;
        let xi = rest % nx;
        let yi = rest / nx;
        pts.push(Pos { x: xs[xi], y: ys[yi] });
        if came_from[k] == usize::MAX {
            break;
        }
        k = came_from[k];
    }
    pts.reverse();

    let simplified = simplify_path(&pts);
    let take = simplified.len().saturating_sub(1).max(1);
    Some(simplified[1..take].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_axis_aligned(path: &[Pos]) {
        for i in 1..path.len() {
            assert!(
                path[i - 1].x == path[i].x || path[i - 1].y == path[i].y,
                "segment {} not axis-aligned: {:?} -> {:?}",
                i,
                path[i - 1],
                path[i]
            );
        }
    }

    fn assert_clear_of(path: &[Pos], obstacles: &[Rect]) {
        for i in 1..path.len() {
            for o in obstacles {
                assert!(
                    !segment_crosses_box(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y, o),
                    "segment {:?} -> {:?} crosses {:?}",
                    path[i - 1],
                    path[i],
                    o
                );
            }
        }
    }

    fn p(x: f64, y: f64) -> Pos {
        Pos { x, y }
    }

    fn r(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Rect {
        Rect { min_x, min_y, max_x, max_y }
    }

    // -- route_avoiding: mirrors src/engine/orthogonalRouterCore.test.ts --

    #[test]
    fn avoiding_returns_none_without_obstacles() {
        assert!(route_avoiding(p(0.0, 0.0), p(200.0, 0.0), (1.0, 0.0), &[]).is_none());
    }

    #[test]
    fn avoiding_returns_none_when_graph_too_large() {
        let obstacles: Vec<Rect> = (0..=MAX_OVG_OBSTACLES)
            .map(|i| r(i as f64 * 10.0, -5.0, i as f64 * 10.0 + 5.0, 5.0))
            .collect();
        assert!(route_avoiding(p(0.0, 0.0), p(500.0, 0.0), (1.0, 0.0), &obstacles).is_none());
    }

    #[test]
    fn avoiding_routes_around_a_wall() {
        let wall = r(80.0, -20.0, 120.0, 20.0);
        let wps = route_avoiding(p(0.0, 0.0), p(200.0, 0.0), (1.0, 0.0), &[wall]).unwrap();
        assert!(!wps.is_empty());
        let path = full_path(p(0.0, 0.0), &wps, p(200.0, 0.0));
        assert_axis_aligned(&path);
        assert_clear_of(&path, &[wall]);
    }

    #[test]
    fn avoiding_is_deterministic() {
        let route = || {
            route_avoiding(p(0.0, 0.0), p(200.0, 0.0), (1.0, 0.0), &[r(80.0, -20.0, 120.0, 20.0)])
        };
        assert_eq!(route(), route());
    }

    // -- Cross-language parity: expected waypoints captured from the TS
    // implementation (bun run over orthogonalRouterCore.ts). Both sides do
    // the same IEEE-double arithmetic, so equality is exact. --

    #[test]
    fn parity_wall_detour_matches_ts_router() {
        let wps =
            route_avoiding(p(0.0, 0.0), p(200.0, 0.0), (1.0, 0.0), &[r(80.0, -20.0, 120.0, 20.0)])
                .unwrap();
        assert_eq!(wps, vec![p(79.0, 0.0), p(79.0, 21.0), p(200.0, 21.0)]);
    }

    #[test]
    fn parity_stacked_seam_matches_ts_router() {
        // Two boxes meeting at y=0: the seam is edge-grazing on both, so the
        // straight route threads it with zero interior waypoints.
        let obstacles = [r(80.0, -60.0, 120.0, 0.0), r(80.0, 0.0, 120.0, 60.0)];
        let wps = route_avoiding(p(0.0, 0.0), p(300.0, 0.0), (1.0, 0.0), &obstacles).unwrap();
        assert_eq!(wps, Vec::<Pos>::new());
    }

    #[test]
    fn parity_vertical_corridor_matches_ts_router() {
        let obstacles = [r(10.0, 100.0, 90.0, 150.0), r(110.0, 100.0, 190.0, 150.0)];
        let wps = route_avoiding(p(50.0, 0.0), p(50.0, 250.0), (0.0, 1.0), &obstacles).unwrap();
        assert_eq!(wps, vec![p(50.0, 99.0), p(9.0, 99.0), p(9.0, 250.0)]);
    }

    // -- route_orthogonal tiering --

    #[test]
    fn clear_field_uses_the_canonical_route() {
        // Right-exit to left-entry across open space: canonical Z with the
        // bend at the alley midpoint.
        let wps = route_orthogonal(p(0.0, 0.0), p(200.0, 100.0), (1.0, 0.0), (-1.0, 0.0), &[], &[]);
        assert_eq!(wps, vec![p(20.0, 0.0), p(100.0, 0.0), p(100.0, 100.0), p(180.0, 100.0)]);
    }

    #[test]
    fn vertical_anchor_pair_makes_a_z_path() {
        // Bottom-exit to top-entry (the layered flow case): Z-path with the
        // horizontal run at the alley midpoint.
        let wps = route_orthogonal(p(0.0, 0.0), p(200.0, 200.0), (0.0, 1.0), (0.0, -1.0), &[], &[]);
        assert_eq!(wps, vec![p(0.0, 20.0), p(0.0, 100.0), p(200.0, 100.0), p(200.0, 180.0)]);
    }

    #[test]
    fn perpendicular_anchors_make_an_l_path() {
        // Right-exit to top-entry: single corner at (end_stub.x, start_stub.y).
        let wps = route_orthogonal(p(0.0, 0.0), p(200.0, 200.0), (1.0, 0.0), (0.0, -1.0), &[], &[]);
        assert_eq!(wps, vec![p(20.0, 0.0), p(200.0, 0.0), p(200.0, 180.0)]);
    }

    #[test]
    fn blocked_canonical_falls_through_to_a_clear_candidate() {
        // An obstacle sits on the canonical mid-alley bend; some other simple
        // candidate (or the OVG) must produce a clear route.
        let obstacle = r(85.0, -30.0, 115.0, 30.0);
        let wps = route_orthogonal(
            p(0.0, 0.0),
            p(200.0, 0.0),
            (1.0, 0.0),
            (-1.0, 0.0),
            &[obstacle],
            &[],
        );
        let path = full_path(p(0.0, 0.0), &wps, p(200.0, 0.0));
        assert_axis_aligned(&path);
        assert_clear_of(&path, &[obstacle]);
    }

    #[test]
    fn connected_shapes_invalidate_middle_segments() {
        // Exit right, target to the left: every simple candidate's middle
        // run cuts back through the start shape, so none validates. With no
        // regular obstacles the editor falls back to the raw canonical
        // candidate (endpoint clipping handles the visual) — parity demands
        // we do the same rather than "improve" on it.
        let connected = [r(-20.0, -40.0, 20.0, 40.0)];
        let wps = route_orthogonal(
            p(20.0, 0.0),
            p(-60.0, 0.0),
            (1.0, 0.0), // forced to exit right, away from the target
            (-1.0, 0.0),
            &[],
            &connected,
        );
        // Canonical Z, unsimplified: stubs at x=40 / x=-80, mid x=-20.
        assert_eq!(wps, vec![p(40.0, 0.0), p(-20.0, 0.0), p(-20.0, 0.0), p(-80.0, 0.0)]);
    }

    #[test]
    fn route_orthogonal_is_deterministic() {
        let obstacles = [r(60.0, -30.0, 140.0, 30.0), r(60.0, 50.0, 140.0, 110.0)];
        let route = || {
            route_orthogonal(
                p(0.0, 0.0),
                p(200.0, 80.0),
                (1.0, 0.0),
                (-1.0, 0.0),
                &obstacles,
                &[],
            )
        };
        assert_eq!(route(), route());
    }
}
