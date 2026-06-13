//! Layer assignment + long-edge normalization.
//!
//! Layering is exact longest-path over the FAS-oriented DAG (`layer[v] =
//! max(layer[u] + 1)` in topological order), followed by one tightening pass
//! that pulls pure sources down next to their nearest successor — the classic
//! longest-path artifact is sources stranded at layer 0 trailing long edges.
//!
//! Normalization then breaks every edge spanning more than one layer into
//! unit segments through virtual nodes. Virtual nodes are what make crossing
//! minimization see long edges at every layer they pass through, and their
//! narrow footprint reserves a vertical routing channel between real nodes.

use super::DUMMY_W;

/// Longest-path layering of a DAG. `edges` must be acyclic (FAS-oriented) and
/// self-loop free. Returns one layer index per node, compacted so used layers
/// are exactly `0..max`.
pub fn assign_layers(n: usize, edges: &[(usize, usize)]) -> Vec<usize> {
    let mut indeg = vec![0usize; n];
    let mut out_adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut in_adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for &(u, v) in edges {
        indeg[v] += 1;
        out_adj[u].push(v);
        in_adj[v].push(u);
    }

    // Kahn topological order (lowest index first — determinism, though the
    // resulting layers are order-independent).
    let mut layer = vec![0usize; n];
    let mut ready: Vec<usize> = (0..n).filter(|&v| indeg[v] == 0).collect();
    let mut processed = 0;
    while let Some(pos) = ready.iter().enumerate().min_by_key(|(_, &v)| v).map(|(i, _)| i) {
        let u = ready.swap_remove(pos);
        processed += 1;
        for &v in &out_adj[u] {
            if layer[v] < layer[u] + 1 {
                layer[v] = layer[u] + 1;
            }
            indeg[v] -= 1;
            if indeg[v] == 0 {
                ready.push(v);
            }
        }
    }
    debug_assert_eq!(processed, n, "assign_layers requires an acyclic edge set");

    // Tightening: a source with successors sits just above its nearest one.
    for v in 0..n {
        if in_adj[v].is_empty() && !out_adj[v].is_empty() {
            let min_succ = out_adj[v].iter().map(|&w| layer[w]).min().unwrap_or(1);
            layer[v] = min_succ.saturating_sub(1);
        }
    }

    compact_layers(&mut layer);
    layer
}

/// Remap layer values so the used set is contiguous from 0.
fn compact_layers(layer: &mut [usize]) {
    if layer.is_empty() {
        return;
    }
    let mut used: Vec<usize> = layer.to_vec();
    used.sort_unstable();
    used.dedup();
    for l in layer.iter_mut() {
        *l = used.binary_search(l).expect("own value is in the used set");
    }
}

/// The layered graph after normalization: real nodes first (their input
/// indices), then virtual nodes appended in edge-input order.
pub struct LGraph {
    pub n_real: usize,
    pub n_total: usize,
    /// Node width/height, indexed by node (virtuals are DUMMY_W x 0).
    pub w: Vec<f64>,
    pub h: Vec<f64>,
    pub layer: Vec<usize>,
    pub n_layers: usize,
    /// Unit-span segments, oriented from lower to higher layer.
    pub segments: Vec<(usize, usize)>,
}

/// Break long edges into unit segments. `edges` are FAS-oriented (every edge
/// spans at least one layer downward). Returns the graph plus, per input
/// edge, the chain of virtual node indices created for it (empty when the
/// edge already had unit span).
pub fn normalize(
    n_real: usize,
    widths: &[f64],
    heights: &[f64],
    layer: Vec<usize>,
    edges: &[(usize, usize)],
) -> (LGraph, Vec<Vec<usize>>) {
    let n_layers = layer.iter().max().map_or(0, |&m| m + 1);
    let mut g = LGraph {
        n_real,
        n_total: n_real,
        w: widths.to_vec(),
        h: heights.to_vec(),
        layer,
        n_layers,
        segments: Vec::new(),
    };
    let mut chains: Vec<Vec<usize>> = Vec::with_capacity(edges.len());

    for &(u, v) in edges {
        let (lu, lv) = (g.layer[u], g.layer[v]);
        debug_assert!(lu < lv, "normalize expects FAS-oriented downward edges");
        if lv - lu == 1 {
            g.segments.push((u, v));
            chains.push(Vec::new());
            continue;
        }
        let mut chain = Vec::with_capacity(lv - lu - 1);
        let mut prev = u;
        for l in (lu + 1)..lv {
            let d = g.n_total;
            g.n_total += 1;
            g.w.push(DUMMY_W);
            g.h.push(0.0);
            g.layer.push(l);
            g.segments.push((prev, d));
            chain.push(d);
            prev = d;
        }
        g.segments.push((prev, v));
        chains.push(chain);
    }

    (g, chains)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn longest_path_layers_a_chain() {
        let layers = assign_layers(3, &[(0, 1), (1, 2)]);
        assert_eq!(layers, vec![0, 1, 2]);
    }

    #[test]
    fn tightening_pulls_sources_next_to_successors() {
        // 0 -> 1 -> 2 -> 3, plus source 4 -> 3. Longest-path leaves 4 at
        // layer 0; tightening pulls it to layer 2, one above its successor.
        let layers = assign_layers(5, &[(0, 1), (1, 2), (2, 3), (4, 3)]);
        assert_eq!(layers[3], 3);
        assert_eq!(layers[4], 2);
    }

    #[test]
    fn isolated_nodes_stay_at_layer_zero() {
        let layers = assign_layers(3, &[(0, 1)]);
        assert_eq!(layers, vec![0, 1, 0]);
    }

    #[test]
    fn normalization_inserts_span_minus_one_dummies() {
        // 0 -> 1 -> 2 -> 3 plus a long edge 0 -> 3 (span 3 → 2 virtuals).
        let edges = vec![(0, 1), (1, 2), (2, 3), (0, 3)];
        let layer = assign_layers(4, &edges);
        let (g, chains) = normalize(4, &[160.0; 4], &[72.0; 4], layer, &edges);
        assert_eq!(g.n_total, 6);
        assert_eq!(chains[0], Vec::<usize>::new());
        assert_eq!(chains[3].len(), 2);
        assert_eq!(g.layer[chains[3][0]], 1);
        assert_eq!(g.layer[chains[3][1]], 2);
        // Every segment spans exactly one layer.
        for &(a, b) in &g.segments {
            assert_eq!(g.layer[b], g.layer[a] + 1);
        }
    }
}
