/**
 * Cycle removal: greedy feedback arc set (Eades–Lin–Smyth 1993).
 *
 * Builds a vertex sequence by repeatedly peeling sinks to the right and
 * sources to the left, otherwise taking the vertex with the largest
 * `outdeg - indeg`. Edges that point right-to-left in the final sequence are
 * the feedback set: the caller treats them as reversed for layering/ordering
 * and keeps the original direction in the emitted shapes.
 *
 * Deterministic: every pick breaks ties by lowest node index (input order).
 * TS twin of `relay/src/mcp/layout/acyclic.rs` — keep the two in step.
 */

/**
 * Per-edge flags marking which of `edges` to treat as reversed so the
 * remaining orientation is acyclic. `edges` must not contain self-loops.
 */
export function greedyFas(n: number, edges: ReadonlyArray<readonly [number, number]>): boolean[] {
  if (n === 0 || edges.length === 0) {
    return edges.map(() => false);
  }

  // Adjacency with multiplicity (parallel edges count toward degrees).
  const outAdj: number[][] = Array.from({ length: n }, () => []);
  const inAdj: number[][] = Array.from({ length: n }, () => []);
  for (const [u, v] of edges) {
    outAdj[u]!.push(v);
    inAdj[v]!.push(u);
  }
  const outdeg = outAdj.map((a) => a.length);
  const indeg = inAdj.map((a) => a.length);

  const removed: boolean[] = new Array(n).fill(false);
  const left: number[] = []; // s1, built front-to-back
  const right: number[] = []; // s2, built back-to-front
  let remaining = n;

  const remove = (v: number): void => {
    removed[v] = true;
    for (const w of outAdj[v]!) {
      if (!removed[w]) indeg[w]! -= 1;
    }
    for (const w of inAdj[v]!) {
      if (!removed[w]) outdeg[w]! -= 1;
    }
  };

  while (remaining > 0) {
    // Peel sinks (lowest index first) to the right sequence.
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let v = 0; v < n; v++) {
        if (!removed[v] && outdeg[v] === 0) {
          right.push(v);
          remove(v);
          remaining -= 1;
          progressed = true;
        }
      }
    }
    // Peel sources (lowest index first) to the left sequence.
    progressed = true;
    while (progressed) {
      progressed = false;
      for (let v = 0; v < n; v++) {
        if (!removed[v] && indeg[v] === 0) {
          left.push(v);
          remove(v);
          remaining -= 1;
          progressed = true;
        }
      }
    }
    if (remaining === 0) break;
    // Cycle core: take max(outdeg - indeg), lowest index on tie.
    let best = -1;
    for (let v = 0; v < n; v++) {
      if (removed[v]) continue;
      if (best < 0 || outdeg[v]! - indeg[v]! > outdeg[best]! - indeg[best]!) {
        best = v;
      }
    }
    left.push(best);
    remove(best);
    remaining -= 1;
  }

  // Sequence position: left order, then right reversed.
  const position: number[] = new Array(n).fill(0);
  let idx = 0;
  for (const v of left) {
    position[v] = idx++;
  }
  for (let i = right.length - 1; i >= 0; i--) {
    position[right[i]!] = idx++;
  }

  return edges.map(([u, v]) => position[u]! > position[v]!);
}
