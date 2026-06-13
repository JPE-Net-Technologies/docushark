//! Vertex ordering / crossing minimization.
//!
//! Layer-by-layer barycenter sweeps (Sugiyama et al. 1981) with a bounded
//! adjacent-transpose polish after each sweep (Gansner et al. 1993), scored by
//! exact bilayer crossing counts (inversion counting, the Barth–Mutzel–Jünger
//! formulation). The best ordering seen across all sweeps wins; ties keep the
//! earlier one.
//!
//! Determinism: the initial order is ascending node index (= input order for
//! real nodes, edge order for virtuals), barycenter sorts are stable, sweep
//! and transpose counts are fixed, and no hash iteration is involved.

use super::rank::LGraph;

/// Number of barycenter sweeps (alternating down/up).
const SWEEPS: usize = 8;
/// Max transpose passes after each sweep.
const TRANSPOSE_PASSES: usize = 4;

/// Compute a per-layer node ordering minimizing edge crossings (heuristic).
pub fn minimize_crossings(g: &LGraph) -> Vec<Vec<usize>> {
    let mut order: Vec<Vec<usize>> = vec![Vec::new(); g.n_layers];
    for v in 0..g.n_total {
        order[g.layer[v]].push(v); // ascending index per layer
    }
    if g.segments.is_empty() || g.n_layers <= 1 {
        return order;
    }

    // Adjacency over unit segments: up = neighbors one layer above, down =
    // neighbors one layer below. Built in segment order (deterministic).
    let mut up: Vec<Vec<usize>> = vec![Vec::new(); g.n_total];
    let mut down: Vec<Vec<usize>> = vec![Vec::new(); g.n_total];
    for &(u, v) in &g.segments {
        down[u].push(v);
        up[v].push(u);
    }

    let mut pos = positions(g.n_total, &order);
    let mut best = order.clone();
    let mut best_crossings = total_crossings(g, &order, &pos);

    for sweep in 0..SWEEPS {
        if sweep % 2 == 0 {
            for layer in order.iter_mut().skip(1) {
                barycenter_sort(layer, &up, &mut pos);
            }
        } else {
            for layer in order.iter_mut().rev().skip(1) {
                barycenter_sort(layer, &down, &mut pos);
            }
        }
        transpose(g, &mut order, &mut pos, &up, &down);

        let crossings = total_crossings(g, &order, &pos);
        if crossings < best_crossings {
            best_crossings = crossings;
            best = order.clone();
            if crossings == 0 {
                break;
            }
        }
    }

    best
}

fn positions(n_total: usize, order: &[Vec<usize>]) -> Vec<usize> {
    let mut pos = vec![0usize; n_total];
    for layer in order {
        for (i, &v) in layer.iter().enumerate() {
            pos[v] = i;
        }
    }
    pos
}

/// Stable-sort one layer by the mean position of its neighbors in the fixed
/// adjacent layer; nodes without neighbors there keep their current position
/// as the key (so they hold station instead of jumping to one end).
fn barycenter_sort(layer: &mut [usize], adj: &[Vec<usize>], pos: &mut [usize]) {
    let keys: Vec<(usize, f64)> = layer
        .iter()
        .map(|&v| {
            let neigh = &adj[v];
            let key = if neigh.is_empty() {
                pos[v] as f64
            } else {
                neigh.iter().map(|&u| pos[u] as f64).sum::<f64>() / neigh.len() as f64
            };
            (v, key)
        })
        .collect();
    let mut sorted = keys;
    sorted.sort_by(|a, b| a.1.partial_cmp(&b.1).expect("barycenter keys are finite"));
    for (i, &(v, _)) in sorted.iter().enumerate() {
        layer[i] = v;
        pos[v] = i;
    }
}

/// Greedy adjacent-exchange polish: swap neighbors whenever it strictly
/// reduces the crossings local to the pair, bounded passes.
fn transpose(
    g: &LGraph,
    order: &mut [Vec<usize>],
    pos: &mut [usize],
    up: &[Vec<usize>],
    down: &[Vec<usize>],
) {
    for _ in 0..TRANSPOSE_PASSES {
        let mut improved = false;
        for layer in order.iter_mut().take(g.n_layers) {
            for i in 0..layer.len().saturating_sub(1) {
                let (a, b) = (layer[i], layer[i + 1]);
                let before = pair_crossings(a, b, up, pos) + pair_crossings(a, b, down, pos);
                let after = pair_crossings(b, a, up, pos) + pair_crossings(b, a, down, pos);
                if after < before {
                    layer[i] = b;
                    layer[i + 1] = a;
                    pos[b] = i;
                    pos[a] = i + 1;
                    improved = true;
                }
            }
        }
        if !improved {
            break;
        }
    }
}

/// Crossings between the edge bundles of two nodes when `a` sits immediately
/// left of `b`: pairs (p, q) with p in N(a), q in N(b), and p right of q.
fn pair_crossings(a: usize, b: usize, adj: &[Vec<usize>], pos: &[usize]) -> usize {
    let mut count = 0;
    for &p in &adj[a] {
        for &q in &adj[b] {
            if pos[p] > pos[q] {
                count += 1;
            }
        }
    }
    count
}

/// Exact crossing count between all adjacent layer pairs: sort each bilayer's
/// segments by upper position and count inversions of the lower positions
/// with a Fenwick tree — O(E log V) per bilayer.
pub fn total_crossings(g: &LGraph, order: &[Vec<usize>], pos: &[usize]) -> usize {
    let mut by_upper_layer: Vec<Vec<(usize, usize)>> = vec![Vec::new(); g.n_layers];
    for &(u, v) in &g.segments {
        by_upper_layer[g.layer[u]].push((pos[u], pos[v]));
    }

    let mut total = 0;
    for (l, mut pairs) in by_upper_layer.into_iter().enumerate() {
        if pairs.len() < 2 {
            continue;
        }
        pairs.sort_unstable();
        let lower_len = order.get(l + 1).map_or(0, |layer| layer.len());
        let mut tree = Fenwick::new(lower_len);
        // Walk in sorted order; each segment crosses every already-seen
        // segment whose lower endpoint is strictly to its right.
        for (i, &(_, lo)) in pairs.iter().enumerate() {
            total += i - tree.prefix_sum(lo);
            tree.add(lo);
        }
    }
    total
}

struct Fenwick {
    tree: Vec<usize>,
}

impl Fenwick {
    fn new(n: usize) -> Self {
        Fenwick { tree: vec![0; n + 1] }
    }

    /// Count of added values <= i.
    fn prefix_sum(&self, i: usize) -> usize {
        let mut idx = i + 1;
        let mut sum = 0;
        while idx > 0 {
            sum += self.tree[idx];
            idx -= idx & idx.wrapping_neg();
        }
        sum
    }

    fn add(&mut self, i: usize) {
        let mut idx = i + 1;
        while idx < self.tree.len() {
            self.tree[idx] += 1;
            idx += idx & idx.wrapping_neg();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::rank::{assign_layers, normalize};
    use super::*;

    fn graph(n: usize, edges: &[(usize, usize)]) -> LGraph {
        let layer = assign_layers(n, edges);
        let (g, _) = normalize(n, &vec![160.0; n], &vec![72.0; n], layer, edges);
        g
    }

    #[test]
    fn parallel_edges_count_zero_crossings() {
        // 0->2, 1->3 with order [0,1] / [2,3]: parallel, no crossing.
        let g = graph(4, &[(0, 2), (1, 3)]);
        let order = vec![vec![0, 1], vec![2, 3]];
        let pos = positions(g.n_total, &order);
        assert_eq!(total_crossings(&g, &order, &pos), 0);
    }

    #[test]
    fn x_pattern_counts_one_crossing() {
        // 0->3, 1->2 with order [0,1] / [2,3]: the segments cross once.
        let g = graph(4, &[(0, 3), (1, 2)]);
        let order = vec![vec![0, 1], vec![2, 3]];
        let pos = positions(g.n_total, &order);
        assert_eq!(total_crossings(&g, &order, &pos), 1);
    }

    #[test]
    fn ordering_removes_the_x_crossing() {
        let g = graph(4, &[(0, 3), (1, 2)]);
        let order = minimize_crossings(&g);
        let pos = positions(g.n_total, &order);
        assert_eq!(total_crossings(&g, &order, &pos), 0);
    }

    #[test]
    fn k22_keeps_exactly_one_crossing() {
        // K2,2 (0,1 -> 2,3 fully connected) cannot do better than 1 crossing.
        let g = graph(4, &[(0, 2), (0, 3), (1, 2), (1, 3)]);
        let order = minimize_crossings(&g);
        let pos = positions(g.n_total, &order);
        assert_eq!(total_crossings(&g, &order, &pos), 1);
    }

    #[test]
    fn ordering_is_deterministic() {
        let edges = vec![(0, 4), (1, 3), (2, 5), (0, 5), (1, 4), (2, 3)];
        let g1 = graph(6, &edges);
        let g2 = graph(6, &edges);
        assert_eq!(minimize_crossings(&g1), minimize_crossings(&g2));
    }
}
