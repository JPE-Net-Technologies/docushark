//! Cycle removal: greedy feedback arc set (Eades–Lin–Smyth 1993).
//!
//! Builds a vertex sequence by repeatedly peeling sinks to the right and
//! sources to the left, otherwise taking the vertex with the largest
//! `outdeg - indeg`. Edges that point right-to-left in the final sequence are
//! the feedback set: the caller treats them as reversed for layering/ordering
//! and restores the original direction when emitting connectors.
//!
//! Deterministic: every pick breaks ties by lowest node index, which is input
//! order at the `layout_diagram` boundary.

/// Per-edge flags marking which of `edges` to treat as reversed so the
/// remaining orientation is acyclic. `edges` must not contain self-loops.
pub fn greedy_fas(n: usize, edges: &[(usize, usize)]) -> Vec<bool> {
    if n == 0 || edges.is_empty() {
        return vec![false; edges.len()];
    }

    // Adjacency with multiplicity (parallel edges count toward degrees).
    let mut out_adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut in_adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for &(u, v) in edges {
        debug_assert_ne!(u, v, "self-loops must be stripped before greedy_fas");
        out_adj[u].push(v);
        in_adj[v].push(u);
    }
    let mut outdeg: Vec<isize> = out_adj.iter().map(|a| a.len() as isize).collect();
    let mut indeg: Vec<isize> = in_adj.iter().map(|a| a.len() as isize).collect();

    let mut removed = vec![false; n];
    let mut left: Vec<usize> = Vec::new(); // s1, built front-to-back
    let mut right: Vec<usize> = Vec::new(); // s2, built back-to-front
    let mut remaining = n;

    let remove = |v: usize,
                  removed: &mut Vec<bool>,
                  outdeg: &mut Vec<isize>,
                  indeg: &mut Vec<isize>,
                  out_adj: &Vec<Vec<usize>>,
                  in_adj: &Vec<Vec<usize>>| {
        removed[v] = true;
        for &w in &out_adj[v] {
            if !removed[w] {
                indeg[w] -= 1;
            }
        }
        for &w in &in_adj[v] {
            if !removed[w] {
                outdeg[w] -= 1;
            }
        }
    };

    while remaining > 0 {
        // Peel sinks (lowest index first) to the right sequence.
        let mut progressed = true;
        while progressed {
            progressed = false;
            for v in 0..n {
                if !removed[v] && outdeg[v] == 0 {
                    right.push(v);
                    remove(v, &mut removed, &mut outdeg, &mut indeg, &out_adj, &in_adj);
                    remaining -= 1;
                    progressed = true;
                }
            }
        }
        // Peel sources (lowest index first) to the left sequence.
        progressed = true;
        while progressed {
            progressed = false;
            for v in 0..n {
                if !removed[v] && indeg[v] == 0 {
                    left.push(v);
                    remove(v, &mut removed, &mut outdeg, &mut indeg, &out_adj, &in_adj);
                    remaining -= 1;
                    progressed = true;
                }
            }
        }
        if remaining == 0 {
            break;
        }
        // Cycle core: take max(outdeg - indeg), lowest index on tie.
        let mut best: Option<usize> = None;
        for v in 0..n {
            if removed[v] {
                continue;
            }
            match best {
                None => best = Some(v),
                Some(b) => {
                    if outdeg[v] - indeg[v] > outdeg[b] - indeg[b] {
                        best = Some(v);
                    }
                }
            }
        }
        let v = best.expect("remaining > 0 implies an unremoved node");
        left.push(v);
        remove(v, &mut removed, &mut outdeg, &mut indeg, &out_adj, &in_adj);
        remaining -= 1;
    }

    // Sequence position: left order, then right reversed.
    let mut position = vec![0usize; n];
    let mut idx = 0;
    for &v in &left {
        position[v] = idx;
        idx += 1;
    }
    for &v in right.iter().rev() {
        position[v] = idx;
        idx += 1;
    }

    edges.iter().map(|&(u, v)| position[u] > position[v]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acyclic_graph_reverses_nothing() {
        let edges = vec![(0, 1), (1, 2), (0, 2)];
        assert_eq!(greedy_fas(3, &edges), vec![false, false, false]);
    }

    #[test]
    fn three_cycle_reverses_exactly_one_edge_deterministically() {
        let edges = vec![(0, 1), (1, 2), (2, 0)];
        let flags = greedy_fas(3, &edges);
        assert_eq!(flags.iter().filter(|&&f| f).count(), 1);
        // Node 0 wins the outdeg-indeg tie by lowest index, so it heads the
        // sequence and the edge back into it (2 -> 0) is the feedback arc.
        assert_eq!(flags, vec![false, false, true]);
    }

    #[test]
    fn two_cycle_reverses_one_edge() {
        let edges = vec![(0, 1), (1, 0)];
        let flags = greedy_fas(2, &edges);
        assert_eq!(flags.iter().filter(|&&f| f).count(), 1);
    }

    #[test]
    fn result_is_acyclic_after_reversal() {
        // Two overlapping cycles.
        let edges = vec![(0, 1), (1, 2), (2, 0), (2, 3), (3, 1)];
        let flags = greedy_fas(4, &edges);
        let oriented: Vec<(usize, usize)> = edges
            .iter()
            .zip(&flags)
            .map(|(&(u, v), &rev)| if rev { (v, u) } else { (u, v) })
            .collect();
        // Kahn's algorithm consumes every node iff the orientation is acyclic.
        let mut indeg = [0usize; 4];
        for &(_, v) in &oriented {
            indeg[v] += 1;
        }
        let mut queue: Vec<usize> = (0..4).filter(|&v| indeg[v] == 0).collect();
        let mut seen = 0;
        while let Some(v) = queue.pop() {
            seen += 1;
            for &(u, w) in &oriented {
                if u == v {
                    indeg[w] -= 1;
                    if indeg[w] == 0 {
                        queue.push(w);
                    }
                }
            }
        }
        assert_eq!(seen, 4);
    }
}
