//! Tiny graph layout for the bulk `generate_diagram` MCP tool (JP-93).
//!
//! The editor's real auto-layout (JP-164 shared graph layout) is TypeScript,
//! editor-side, and can't run in the relay. So we compute a *good-enough*
//! placement here — a grid for loose node sets, a longest-path layering for
//! graphs with edges — and let the editor re-layout on open if the user wants.
//! Coordinates are world-space, matching what the canvas tools already use.

use std::collections::BTreeMap;

/// Node footprint + spacing used when placing generated shapes.
pub const NODE_W: f64 = 160.0;
pub const NODE_H: f64 = 72.0;
const COL_GAP: f64 = 80.0;
const ROW_GAP: f64 = 80.0;
const ORIGIN: f64 = 40.0;

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

/// Place `node_ids` (input order preserved for determinism). `edges` are
/// (from, to) pairs of node ids; endpoints not in `node_ids` are ignored.
/// Returns positions in the same order as `node_ids`.
pub fn layout(node_ids: &[String], edges: &[(String, String)], mode: LayoutMode) -> Vec<(String, Pos)> {
    match mode {
        LayoutMode::Grid => grid(node_ids),
        LayoutMode::Layered => layered(node_ids, edges),
    }
}

fn grid(node_ids: &[String]) -> Vec<(String, Pos)> {
    let cols = ((node_ids.len() as f64).sqrt().ceil() as usize).max(1);
    node_ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            let (row, col) = (i / cols, i % cols);
            (
                id.clone(),
                Pos {
                    x: ORIGIN + col as f64 * (NODE_W + COL_GAP),
                    y: ORIGIN + row as f64 * (NODE_H + ROW_GAP),
                },
            )
        })
        .collect()
}

fn layered(node_ids: &[String], edges: &[(String, String)]) -> Vec<(String, Pos)> {
    let known: std::collections::HashSet<&str> = node_ids.iter().map(|s| s.as_str()).collect();

    // Longest-path layering: layer[v] = max(layer[u] + 1) over edges u->v.
    // Bounded to node_ids.len() passes, so a cycle stops growing instead of
    // looping forever (its members just settle at some depth).
    let mut layer: BTreeMap<&str, usize> = node_ids.iter().map(|s| (s.as_str(), 0usize)).collect();
    for _ in 0..node_ids.len() {
        let mut changed = false;
        for (u, v) in edges {
            if let (Some(&lu), true) = (layer.get(u.as_str()), known.contains(v.as_str())) {
                let lv = layer.get(v.as_str()).copied().unwrap_or(0);
                if lv < lu + 1 {
                    layer.insert(v.as_str(), lu + 1);
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }

    // Bucket nodes by layer, preserving input order within each layer.
    let mut by_layer: BTreeMap<usize, Vec<&str>> = BTreeMap::new();
    for id in node_ids {
        let l = layer.get(id.as_str()).copied().unwrap_or(0);
        by_layer.entry(l).or_default().push(id.as_str());
    }

    let mut pos: std::collections::HashMap<&str, Pos> = std::collections::HashMap::new();
    for (&l, members) in &by_layer {
        for (idx, id) in members.iter().enumerate() {
            pos.insert(
                id,
                Pos {
                    x: ORIGIN + idx as f64 * (NODE_W + COL_GAP),
                    y: ORIGIN + l as f64 * (NODE_H + ROW_GAP),
                },
            );
        }
    }

    node_ids
        .iter()
        .map(|id| (id.clone(), pos.get(id.as_str()).copied().unwrap_or(Pos { x: ORIGIN, y: ORIGIN })))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
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
        let nodes = ids(&["a", "b", "c"]);
        let edges = vec![("a".to_string(), "b".to_string()), ("b".to_string(), "c".to_string())];
        let p = layout(&nodes, &edges, LayoutMode::Layered);
        let y = |id: &str| p.iter().find(|(n, _)| n == id).unwrap().1.y;
        assert!(y("a") < y("b"));
        assert!(y("b") < y("c"));
    }

    #[test]
    fn layered_handles_a_cycle_without_hanging() {
        let nodes = ids(&["a", "b"]);
        let edges = vec![("a".to_string(), "b".to_string()), ("b".to_string(), "a".to_string())];
        let p = layout(&nodes, &edges, LayoutMode::Layered);
        assert_eq!(p.len(), 2); // terminates, both placed
    }

    #[test]
    fn layered_siblings_share_a_row_but_differ_in_x() {
        // a -> b, a -> c : b and c are both layer 1.
        let nodes = ids(&["a", "b", "c"]);
        let edges = vec![("a".to_string(), "b".to_string()), ("a".to_string(), "c".to_string())];
        let p = layout(&nodes, &edges, LayoutMode::Layered);
        let get = |id: &str| *p.iter().find(|(n, _)| n == id).map(|(_, q)| q).unwrap();
        assert_eq!(get("b").y, get("c").y);
        assert_ne!(get("b").x, get("c").x);
    }
}
