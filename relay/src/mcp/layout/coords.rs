//! Coordinate assignment: the priority method (Sugiyama et al. 1981, as
//! refined by Gansner et al. 1993).
//!
//! Alternating down/up sweeps move each node toward the median x of its
//! neighbors in the fixed adjacent layer, processed in descending priority
//! (degree toward the fixed layer). A move may push lower-priority neighbors
//! aside but never equal-or-higher ones, so well-connected nodes and virtual
//! chains end up aligned. Virtual nodes get maximum priority — their chains
//! straighten into the vertical channels long edges route through.
//!
//! Chosen over Brandes–Köpf: nodes are uniform-size today, the priority
//! method is a fraction of the code, and it is trivially deterministic.
//! B–K (with the Rüegg size-aware extension) is the upgrade path if strongly
//! heterogeneous node sizes land later.

use super::rank::LGraph;
use super::{Pos, COL_GAP, ORIGIN, ROW_GAP};

/// Horizontal gap when at least one of the two neighbors is a virtual node —
/// narrower than COL_GAP so routing channels don't balloon the drawing.
const VIRTUAL_GAP: f64 = 20.0;

/// Coordinate sweeps (alternating down/up).
const SWEEPS: usize = 8;

/// Assign center coordinates to every node (real + virtual). Real nodes are
/// translated so their minimum center sits at (ORIGIN, ORIGIN), matching the
/// previous layout's convention.
pub fn assign_coords(g: &LGraph, order: &[Vec<usize>]) -> Vec<Pos> {
    let mut up: Vec<Vec<usize>> = vec![Vec::new(); g.n_total];
    let mut down: Vec<Vec<usize>> = vec![Vec::new(); g.n_total];
    for &(u, v) in &g.segments {
        down[u].push(v);
        up[v].push(u);
    }

    // Initial x: pack each layer left-to-right from 0.
    let mut x = vec![0.0f64; g.n_total];
    for layer in order {
        for i in 1..layer.len() {
            x[layer[i]] = x[layer[i - 1]] + separation(g, layer[i - 1], layer[i]);
        }
    }

    for sweep in 0..SWEEPS {
        if sweep % 2 == 0 {
            for layer in order.iter().skip(1) {
                priority_pass(g, layer, &up, &mut x);
            }
        } else {
            for layer in order.iter().rev().skip(1) {
                priority_pass(g, layer, &down, &mut x);
            }
        }
    }

    // y: stack layers by max height + ROW_GAP.
    let mut layer_h = vec![0.0f64; g.n_layers];
    for v in 0..g.n_total {
        if g.h[v] > layer_h[g.layer[v]] {
            layer_h[g.layer[v]] = g.h[v];
        }
    }
    let mut layer_cy = vec![0.0f64; g.n_layers];
    let mut top = 0.0;
    for l in 0..g.n_layers {
        layer_cy[l] = top + layer_h[l] / 2.0;
        top += layer_h[l] + ROW_GAP;
    }

    // Translate so the minimum real-node center is (ORIGIN, ORIGIN).
    let min_x = (0..g.n_real).map(|v| x[v]).fold(f64::INFINITY, f64::min);
    let min_cy = (0..g.n_real)
        .map(|v| layer_cy[g.layer[v]])
        .fold(f64::INFINITY, f64::min);
    let (dx, dy) = if g.n_real > 0 {
        (ORIGIN - min_x, ORIGIN - min_cy)
    } else {
        (ORIGIN, ORIGIN)
    };

    (0..g.n_total)
        .map(|v| Pos {
            x: x[v] + dx,
            y: layer_cy[g.layer[v]] + dy,
        })
        .collect()
}

/// Minimum center-to-center distance between two horizontal neighbors.
fn separation(g: &LGraph, a: usize, b: usize) -> f64 {
    let gap = if a < g.n_real && b < g.n_real { COL_GAP } else { VIRTUAL_GAP };
    g.w[a] / 2.0 + g.w[b] / 2.0 + gap
}

/// One priority pass over `layer`: nodes in descending priority move toward
/// the median x of their neighbors in the fixed layer, pushing only
/// lower-priority nodes aside.
fn priority_pass(g: &LGraph, layer: &[usize], adj: &[Vec<usize>], x: &mut [f64]) {
    let priority = |v: usize| -> usize {
        if v >= g.n_real {
            usize::MAX
        } else {
            adj[v].len()
        }
    };

    // Visit order: descending priority, position (left-to-right) on ties.
    let mut visit: Vec<usize> = (0..layer.len()).collect();
    visit.sort_by(|&i, &j| priority(layer[j]).cmp(&priority(layer[i])).then(i.cmp(&j)));

    for &i in &visit {
        let v = layer[i];
        if adj[v].is_empty() {
            continue;
        }
        let desired = median(adj[v].iter().map(|&u| x[u]));
        let p = priority(v);

        if desired > x[v] {
            // Wall: nearest right neighbor with priority >= p.
            let mut limit = f64::INFINITY;
            let mut acc = 0.0;
            for j in (i + 1)..layer.len() {
                acc += separation(g, layer[j - 1], layer[j]);
                if priority(layer[j]) >= p {
                    limit = x[layer[j]] - acc;
                    break;
                }
            }
            let new_x = desired.min(limit);
            if new_x > x[v] {
                x[v] = new_x;
                for j in (i + 1)..layer.len() {
                    let min_x = x[layer[j - 1]] + separation(g, layer[j - 1], layer[j]);
                    if x[layer[j]] < min_x {
                        x[layer[j]] = min_x;
                    } else {
                        break;
                    }
                }
            }
        } else if desired < x[v] {
            let mut limit = f64::NEG_INFINITY;
            let mut acc = 0.0;
            for j in (0..i).rev() {
                acc += separation(g, layer[j], layer[j + 1]);
                if priority(layer[j]) >= p {
                    limit = x[layer[j]] + acc;
                    break;
                }
            }
            let new_x = desired.max(limit);
            if new_x < x[v] {
                x[v] = new_x;
                for j in (0..i).rev() {
                    let max_x = x[layer[j + 1]] - separation(g, layer[j], layer[j + 1]);
                    if x[layer[j]] > max_x {
                        x[layer[j]] = max_x;
                    } else {
                        break;
                    }
                }
            }
        }
    }
}

/// Median of the values; mean of the two middles on even counts.
fn median(values: impl Iterator<Item = f64>) -> f64 {
    let mut v: Vec<f64> = values.collect();
    v.sort_by(|a, b| a.partial_cmp(b).expect("coordinates are finite"));
    let n = v.len();
    debug_assert!(n > 0, "median of empty neighbor set");
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::super::order::minimize_crossings;
    use super::super::rank::{assign_layers, normalize};
    use super::*;
    use super::super::{NODE_H, NODE_W};

    fn coords(n: usize, edges: &[(usize, usize)]) -> (LGraph, Vec<Pos>) {
        let layer = assign_layers(n, edges);
        let (g, _) = normalize(n, &vec![NODE_W; n], &vec![NODE_H; n], layer, edges);
        let order = minimize_crossings(&g);
        let pos = assign_coords(&g, &order);
        (g, pos)
    }

    #[test]
    fn no_two_real_nodes_overlap() {
        let edges = vec![(0, 1), (0, 2), (0, 3), (1, 4), (2, 4), (3, 4), (0, 4)];
        let (g, pos) = coords(5, &edges);
        for a in 0..g.n_real {
            for b in (a + 1)..g.n_real {
                let dx = (pos[a].x - pos[b].x).abs();
                let dy = (pos[a].y - pos[b].y).abs();
                let overlap_x = dx < (g.w[a] + g.w[b]) / 2.0;
                let overlap_y = dy < (g.h[a] + g.h[b]) / 2.0;
                assert!(
                    !(overlap_x && overlap_y),
                    "nodes {} and {} overlap: {:?} vs {:?}",
                    a,
                    b,
                    pos[a],
                    pos[b]
                );
            }
        }
    }

    #[test]
    fn minimum_real_center_is_origin() {
        let edges = vec![(0, 1), (0, 2), (1, 3), (2, 3)];
        let (g, pos) = coords(4, &edges);
        let min_x = (0..g.n_real).map(|v| pos[v].x).fold(f64::INFINITY, f64::min);
        let min_y = (0..g.n_real).map(|v| pos[v].y).fold(f64::INFINITY, f64::min);
        assert_eq!(min_x, ORIGIN);
        assert_eq!(min_y, ORIGIN);
    }

    #[test]
    fn single_parent_centers_over_children() {
        // 0 -> 1, 0 -> 2: parent ends centered between its two children.
        let (_, pos) = coords(3, &[(0, 1), (0, 2)]);
        let mid = (pos[1].x + pos[2].x) / 2.0;
        assert!((pos[0].x - mid).abs() < 1.0, "parent at {}, children mid {}", pos[0].x, mid);
    }

    #[test]
    fn layers_separated_by_row_gap() {
        let (_, pos) = coords(2, &[(0, 1)]);
        assert_eq!(pos[1].y - pos[0].y, NODE_H + ROW_GAP);
    }
}
