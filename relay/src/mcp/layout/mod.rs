//! Graph auto-layout for the bulk `generate_diagram` MCP tool (JP-93, JP-245).
//!
//! Layered mode runs a Sugiyama pipeline — greedy feedback-arc-set cycle
//! removal, longest-path layering with source tightening, long-edge
//! normalization through virtual nodes, barycenter/transpose crossing
//! minimization, and priority-method coordinates — then assigns typed
//! connector anchors from each edge's rank relationship. Grid mode keeps the
//! simple sqrt(n) grid for edgeless node sets, with dominant-axis anchors.
//!
//! Everything is deterministic (fixed sweep counts, all ties broken by input
//! order, no hash iteration): regenerating the same graph reproduces the same
//! geometry. Coordinates are world-space shape centers (`BaseShape.x/y` is
//! the center for rect/ellipse — see `src/shapes/Shape.ts`).

mod acyclic;
mod coords;
mod order;
mod rank;

/// Node footprint + spacing used when placing generated shapes.
pub const NODE_W: f64 = 160.0;
pub const NODE_H: f64 = 72.0;
const COL_GAP: f64 = 80.0;
const ROW_GAP: f64 = 80.0;
const ORIGIN: f64 = 40.0;
/// Width reserved by a virtual (dummy) node — the vertical channel a long
/// edge routes through between real nodes.
const DUMMY_W: f64 = 8.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pos {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LayoutMode {
    Grid,
    Layered,
}

/// Typed connector attachment point on a node's bounding box. Names mirror
/// the editor's `AnchorPosition` (`src/shapes/Shape.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anchor {
    Top,
    Right,
    Bottom,
    Left,
    Center,
}

impl Anchor {
    pub fn as_str(self) -> &'static str {
        match self {
            Anchor::Top => "top",
            Anchor::Right => "right",
            Anchor::Bottom => "bottom",
            Anchor::Left => "left",
            Anchor::Center => "center",
        }
    }

    /// World point of this anchor on a node with center (x, y) and size (w, h).
    pub fn point(self, x: f64, y: f64, w: f64, h: f64) -> Pos {
        match self {
            Anchor::Top => Pos { x, y: y - h / 2.0 },
            Anchor::Right => Pos { x: x + w / 2.0, y },
            Anchor::Bottom => Pos { x, y: y + h / 2.0 },
            Anchor::Left => Pos { x: x - w / 2.0, y },
            Anchor::Center => Pos { x, y },
        }
    }

    /// Exit direction, matching the editor's `STANDARD_ANCHOR_DIRECTIONS`
    /// (`src/engine/OrthogonalRouter.ts`). Center means "infer".
    pub fn dir(self) -> (f64, f64) {
        match self {
            Anchor::Top => (0.0, -1.0),
            Anchor::Right => (1.0, 0.0),
            Anchor::Bottom => (0.0, 1.0),
            Anchor::Left => (-1.0, 0.0),
            Anchor::Center => (0.0, 0.0),
        }
    }
}

/// A node to lay out: id plus its actual footprint (text/library shapes vary;
/// `generate_diagram` passes the uniform NODE_W x NODE_H today).
pub struct NodeSpec {
    pub id: String,
    pub w: f64,
    pub h: f64,
}

/// Layout result for one input edge, in input order.
pub struct RoutedEdge {
    pub start_anchor: Anchor,
    pub end_anchor: Anchor,
    /// Interior waypoints of the routed path (empty = straight anchor-to-
    /// anchor). Routing lands with the JP-245 router; the layout pipeline
    /// emits the anchors + endpoints it needs.
    pub waypoints: Vec<Pos>,
    /// Resolved start/end anchor points (seeds the connector's x/y + x2/y2).
    pub start: Pos,
    pub end: Pos,
    /// Arc-length label position when staggered off the editor's 0.5 default.
    pub label_position: Option<f64>,
}

/// Full diagram layout: node centers (input order) + per-edge anchors/routes.
pub struct DiagramLayout {
    pub nodes: Vec<(String, Pos)>,
    pub edges: Vec<RoutedEdge>,
}

/// Back-compat wrapper returning only node positions. Prefer
/// [`layout_diagram`], which also assigns connector anchors.
pub fn layout(node_ids: &[String], edges: &[(String, String)], mode: LayoutMode) -> Vec<(String, Pos)> {
    let specs: Vec<NodeSpec> = node_ids
        .iter()
        .map(|id| NodeSpec { id: id.clone(), w: NODE_W, h: NODE_H })
        .collect();
    layout_diagram(&specs, edges, mode).nodes
}

/// Lay out `nodes` (input order preserved) and assign per-edge anchors.
/// `edges` are (from, to) pairs of node ids; edges whose endpoints aren't in
/// `nodes` get center anchors and no geometry (callers validate upstream).
pub fn layout_diagram(nodes: &[NodeSpec], edges: &[(String, String)], mode: LayoutMode) -> DiagramLayout {
    let index: std::collections::BTreeMap<&str, usize> =
        nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i)).collect();

    // Classify edges once; the pipeline only sees normal (known, non-loop) ones.
    enum EdgeClass {
        Unknown,
        SelfLoop(usize),
        Normal { from: usize, to: usize, pipeline_idx: usize },
    }
    let mut classes: Vec<EdgeClass> = Vec::with_capacity(edges.len());
    let mut pipeline_edges: Vec<(usize, usize)> = Vec::new();
    for (from_id, to_id) in edges {
        match (index.get(from_id.as_str()), index.get(to_id.as_str())) {
            (Some(&u), Some(&v)) if u == v => classes.push(EdgeClass::SelfLoop(u)),
            (Some(&u), Some(&v)) => {
                classes.push(EdgeClass::Normal { from: u, to: v, pipeline_idx: pipeline_edges.len() });
                pipeline_edges.push((u, v));
            }
            _ => classes.push(EdgeClass::Unknown),
        }
    }

    let (positions, reversed) = match mode {
        LayoutMode::Grid => (grid(nodes), vec![false; pipeline_edges.len()]),
        LayoutMode::Layered => {
            let reversed = acyclic::greedy_fas(nodes.len(), &pipeline_edges);
            let oriented: Vec<(usize, usize)> = pipeline_edges
                .iter()
                .zip(&reversed)
                .map(|(&(u, v), &rev)| if rev { (v, u) } else { (u, v) })
                .collect();
            let widths: Vec<f64> = nodes.iter().map(|n| n.w).collect();
            let heights: Vec<f64> = nodes.iter().map(|n| n.h).collect();
            let layer = rank::assign_layers(nodes.len(), &oriented);
            let (g, _chains) = rank::normalize(nodes.len(), &widths, &heights, layer, &oriented);
            let order = order::minimize_crossings(&g);
            let all = coords::assign_coords(&g, &order);
            (all[..nodes.len()].to_vec(), reversed)
        }
    };

    let anchor_point = |v: usize, a: Anchor| -> Pos {
        a.point(positions[v].x, positions[v].y, nodes[v].w, nodes[v].h)
    };

    let routed: Vec<RoutedEdge> = classes
        .iter()
        .map(|class| match *class {
            EdgeClass::Unknown => RoutedEdge {
                start_anchor: Anchor::Center,
                end_anchor: Anchor::Center,
                waypoints: Vec::new(),
                start: Pos { x: ORIGIN, y: ORIGIN },
                end: Pos { x: ORIGIN, y: ORIGIN },
                label_position: None,
            },
            EdgeClass::SelfLoop(v) => RoutedEdge {
                start_anchor: Anchor::Right,
                end_anchor: Anchor::Bottom,
                waypoints: Vec::new(),
                start: anchor_point(v, Anchor::Right),
                end: anchor_point(v, Anchor::Bottom),
                label_position: None,
            },
            EdgeClass::Normal { from, to, pipeline_idx } => {
                let (sa, ea) = edge_anchors(
                    mode,
                    reversed[pipeline_idx],
                    positions[from],
                    positions[to],
                    from,
                    to,
                );
                RoutedEdge {
                    start_anchor: sa,
                    end_anchor: ea,
                    waypoints: Vec::new(),
                    start: anchor_point(from, sa),
                    end: anchor_point(to, ea),
                    label_position: None,
                }
            }
        })
        .collect();

    DiagramLayout {
        nodes: nodes.iter().zip(&positions).map(|(n, &p)| (n.id.clone(), p)).collect(),
        edges: routed,
    }
}

/// Anchor pair for a normal (non-loop) edge.
///
/// Layered: forward edges flow bottom -> top of the next rank; back-edges
/// (reversed by the FAS) leave and enter on the right flank so the router can
/// take them around the drawing. Grid (and the defensive same-row case):
/// dominant-axis rule, horizontal on ties.
fn edge_anchors(
    mode: LayoutMode,
    reversed: bool,
    from: Pos,
    to: Pos,
    from_idx: usize,
    to_idx: usize,
) -> (Anchor, Anchor) {
    if mode == LayoutMode::Layered {
        if reversed {
            return (Anchor::Right, Anchor::Right);
        }
        if to.y > from.y {
            return (Anchor::Bottom, Anchor::Top);
        }
        if to.y < from.y {
            // Defensive: layering guarantees forward edges descend, but keep
            // a sane answer if positions say otherwise.
            return (Anchor::Top, Anchor::Bottom);
        }
        // Same row: point along x, lower input index wins the exact-tie.
        return if to.x > from.x || (to.x == from.x && from_idx < to_idx) {
            (Anchor::Right, Anchor::Left)
        } else {
            (Anchor::Left, Anchor::Right)
        };
    }

    let (dx, dy) = (to.x - from.x, to.y - from.y);
    if dx.abs() >= dy.abs() {
        if dx >= 0.0 {
            (Anchor::Right, Anchor::Left)
        } else {
            (Anchor::Left, Anchor::Right)
        }
    } else if dy >= 0.0 {
        (Anchor::Bottom, Anchor::Top)
    } else {
        (Anchor::Top, Anchor::Bottom)
    }
}

fn grid(nodes: &[NodeSpec]) -> Vec<Pos> {
    let cols = ((nodes.len() as f64).sqrt().ceil() as usize).max(1);
    nodes
        .iter()
        .enumerate()
        .map(|(i, _)| {
            let (row, col) = (i / cols, i % cols);
            Pos {
                x: ORIGIN + col as f64 * (NODE_W + COL_GAP),
                y: ORIGIN + row as f64 * (NODE_H + ROW_GAP),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn e(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    fn specs(v: &[&str]) -> Vec<NodeSpec> {
        v.iter().map(|s| NodeSpec { id: s.to_string(), w: NODE_W, h: NODE_H }).collect()
    }

    #[test]
    fn grid_places_all_nodes_starting_at_origin() {
        let p = layout(&ids(&["a", "b", "c", "d"]), &[], LayoutMode::Grid);
        assert_eq!(p.len(), 4);
        assert_eq!(p[0].1, Pos { x: ORIGIN, y: ORIGIN });
        // 4 nodes → 2 cols; node 2 starts a new row.
        assert!(p[2].1.y > p[0].1.y);
    }

    #[test]
    fn layered_increases_depth_along_edges() {
        let p = layout(&ids(&["a", "b", "c"]), &e(&[("a", "b"), ("b", "c")]), LayoutMode::Layered);
        let y = |id: &str| p.iter().find(|(n, _)| n == id).unwrap().1.y;
        assert!(y("a") < y("b"));
        assert!(y("b") < y("c"));
    }

    #[test]
    fn layered_handles_a_cycle_without_hanging() {
        let p = layout(&ids(&["a", "b"]), &e(&[("a", "b"), ("b", "a")]), LayoutMode::Layered);
        assert_eq!(p.len(), 2); // terminates, both placed
    }

    #[test]
    fn layered_siblings_share_a_row_but_differ_in_x() {
        // a -> b, a -> c : b and c are both layer 1.
        let p = layout(&ids(&["a", "b", "c"]), &e(&[("a", "b"), ("a", "c")]), LayoutMode::Layered);
        let get = |id: &str| *p.iter().find(|(n, _)| n == id).map(|(_, q)| q).unwrap();
        assert_eq!(get("b").y, get("c").y);
        assert_ne!(get("b").x, get("c").x);
    }

    #[test]
    fn forward_edges_get_bottom_to_top_anchors() {
        let d = layout_diagram(&specs(&["a", "b"]), &e(&[("a", "b")]), LayoutMode::Layered);
        assert_eq!(d.edges[0].start_anchor, Anchor::Bottom);
        assert_eq!(d.edges[0].end_anchor, Anchor::Top);
        // Resolved points sit on the box edges between the two nodes.
        let (a, b) = (d.nodes[0].1, d.nodes[1].1);
        assert_eq!(d.edges[0].start, Pos { x: a.x, y: a.y + NODE_H / 2.0 });
        assert_eq!(d.edges[0].end, Pos { x: b.x, y: b.y - NODE_H / 2.0 });
    }

    #[test]
    fn back_edges_route_via_the_right_flank() {
        let d = layout_diagram(
            &specs(&["a", "b", "c"]),
            &e(&[("a", "b"), ("b", "c"), ("c", "a")]),
            LayoutMode::Layered,
        );
        // The FAS reverses c -> a (the edge closing the cycle).
        assert_eq!(d.edges[2].start_anchor, Anchor::Right);
        assert_eq!(d.edges[2].end_anchor, Anchor::Right);
        // The forward edges keep flow anchors.
        assert_eq!(d.edges[0].start_anchor, Anchor::Bottom);
        assert_eq!(d.edges[1].end_anchor, Anchor::Top);
    }

    #[test]
    fn self_loops_use_right_to_bottom() {
        let d = layout_diagram(&specs(&["a"]), &e(&[("a", "a")]), LayoutMode::Layered);
        assert_eq!(d.edges[0].start_anchor, Anchor::Right);
        assert_eq!(d.edges[0].end_anchor, Anchor::Bottom);
    }

    #[test]
    fn grid_edges_use_dominant_axis_anchors() {
        // 4 nodes → 2x2 grid: a..d at (0,0) (1,0) (0,1) (1,1) cells.
        let d = layout_diagram(
            &specs(&["a", "b", "c", "d"]),
            &e(&[("a", "b"), ("a", "c")]),
            LayoutMode::Grid,
        );
        // a -> b is horizontal.
        assert_eq!(d.edges[0].start_anchor, Anchor::Right);
        assert_eq!(d.edges[0].end_anchor, Anchor::Left);
        // a -> c is vertical.
        assert_eq!(d.edges[1].start_anchor, Anchor::Bottom);
        assert_eq!(d.edges[1].end_anchor, Anchor::Top);
    }

    #[test]
    fn unknown_endpoints_fall_back_to_center() {
        let d = layout_diagram(&specs(&["a"]), &e(&[("a", "ghost")]), LayoutMode::Layered);
        assert_eq!(d.edges[0].start_anchor, Anchor::Center);
        assert_eq!(d.edges[0].end_anchor, Anchor::Center);
    }

    #[test]
    fn crossing_minimization_orders_siblings_under_their_parents() {
        // Two parents each with a dedicated child, listed in crossing order:
        // a -> y, b -> x. Input order would draw an X; ordering uncrosses it.
        let d = layout_diagram(
            &specs(&["a", "b", "x", "y"]),
            &e(&[("a", "y"), ("b", "x")]),
            LayoutMode::Layered,
        );
        let x_of = |id: &str| d.nodes.iter().find(|(n, _)| n == id).unwrap().1.x;
        // a left of b implies y left of x (no crossing).
        let (a, b, x, y) = (x_of("a"), x_of("b"), x_of("x"), x_of("y"));
        assert_eq!(a < b, y < x, "edges still cross: a={} b={} x={} y={}", a, b, x, y);
    }

    #[test]
    fn layout_diagram_is_deterministic() {
        // A dozen nodes with a cycle, a long edge, and fan-in/fan-out.
        let nodes = specs(&["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]);
        let edges = e(&[
            ("a", "b"),
            ("a", "c"),
            ("b", "d"),
            ("c", "d"),
            ("d", "e"),
            ("e", "f"),
            ("f", "b"), // cycle back
            ("a", "f"), // long edge (span > 1)
            ("g", "h"),
            ("h", "i"),
            ("g", "i"),
            ("j", "k"),
            ("k", "l"),
            ("j", "l"),
            ("d", "j"),
        ]);
        let d1 = layout_diagram(&nodes, &edges, LayoutMode::Layered);
        let d2 = layout_diagram(&nodes, &edges, LayoutMode::Layered);
        assert_eq!(d1.nodes, d2.nodes);
        for (e1, e2) in d1.edges.iter().zip(&d2.edges) {
            assert_eq!(e1.start_anchor, e2.start_anchor);
            assert_eq!(e1.end_anchor, e2.end_anchor);
            assert_eq!(e1.start, e2.start);
            assert_eq!(e1.end, e2.end);
            assert_eq!(e1.waypoints, e2.waypoints);
        }
    }
}
