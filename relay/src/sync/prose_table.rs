//! Span-aware table grid + rectification (JP-432 Pillar D).
//!
//! The editor's tables are prosemirror-tables tables: a cell may carry
//! `colspan`/`rowspan` (occupying a rectangle of grid slots — a rowspan cell's
//! node lives in its FIRST row but covers slots in later rows) and `colwidth`
//! (one width per spanned column). A normalizer that counts row children
//! (`row.children.len()`) instead of resolving the grid corrupts every merge:
//! the 2026-07-11 live incident padded phantom cells into rows that were
//! already full because a merged cell covered the "missing" slots.
//!
//! This module owns the 2-D occupancy model. [`rectify_table_rows`] is the
//! sanitize-side fixer (called by `prose_validate::normalize_table`);
//! [`TableGrid`] is the strict resolved view the MCP table verbs address.
//!
//! **Contract with the editor:** rectified output must be problem-free under
//! prosemirror-tables' `computeMap` (no collision / overlong_rowspan /
//! missing / zero_sized), so the editor's `fixTables` pass has nothing to
//! repair — otherwise every open of a relay-written doc emits a healing
//! transaction into the collab session. The fixes applied here mirror
//! `fixTable`'s outcomes (shrink colliding colspans via removeColSpan
//! semantics, clamp overlong rowspans, pad logically-short rows) without its
//! transaction-ordering quirks.

use super::prose_parse::{PmChild, PmNode};

// ---- cell attr accessors ------------------------------------------------------

pub(super) fn get_attr<'a>(node: &'a PmNode, name: &str) -> Option<&'a str> {
    node.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

pub(super) fn set_attr(node: &mut PmNode, name: &str, value: String) {
    match node.attrs.iter_mut().find(|(k, _)| k == name) {
        Some((_, v)) => *v = value,
        None => node.attrs.push((name.to_string(), value)),
    }
}

pub(super) fn remove_attr(node: &mut PmNode, name: &str) {
    node.attrs.retain(|(k, _)| k != name);
}

/// A cell's spans, parsed leniently: absent → 1, garbage / zero / negative → 1
/// (the caller normalizes the attr away — prosemirror-tables treats spans as
/// positive ints and the editor never writes anything else).
pub(super) fn cell_spans(cell: &PmNode) -> (usize, usize) {
    let parse = |v: Option<&str>| -> usize {
        v.and_then(|s| s.trim().parse::<i64>().ok())
            .filter(|n| *n >= 1)
            .map(|n| n as usize)
            .unwrap_or(1)
    };
    (parse(get_attr(cell, "colspan")), parse(get_attr(cell, "rowspan")))
}

/// A cell's `colwidth` (`"100,120"` → `[100, 120]`), `None` when absent or
/// malformed (any non-numeric / non-positive segment poisons the whole value —
/// the editor only ever writes positive ints or omits the attr; a `0` entry is
/// PM's "unknown width" placeholder and is kept).
pub(super) fn cell_colwidth(cell: &PmNode) -> Option<Vec<u32>> {
    let raw = get_attr(cell, "colwidth")?;
    let widths: Option<Vec<u32>> = raw
        .split(',')
        .map(|w| w.trim().parse::<u32>().ok())
        .collect();
    widths.filter(|w| !w.is_empty())
}

/// An empty cell of `node_type` (`tableCell` / `tableHeader`) holding one empty
/// paragraph — the shape prosemirror-tables' `createAndFill` pads with. Pads
/// inherit the ROW's cell role (a header row pads with `tableHeader`), mirroring
/// `fixTable`'s `row.firstChild` role lookup.
fn empty_cell_of(node_type: &str) -> PmNode {
    PmNode {
        node_type: node_type.to_string(),
        attrs: vec![],
        children: vec![PmChild::Node(PmNode {
            node_type: "paragraph".to_string(),
            attrs: vec![],
            children: vec![],
        })],
    }
}

/// The row's pad role: its first cell's type, else `tableCell`.
fn row_pad_role(row: &PmNode) -> &'static str {
    for child in &row.children {
        if let PmChild::Node(n) = child {
            if n.node_type == "tableHeader" {
                return "tableHeader";
            }
            if n.node_type == "tableCell" {
                return "tableCell";
            }
        }
    }
    "tableCell"
}

/// Logical table width, prosemirror-tables `findWidth` semantics: a row's
/// width = carry-ins (earlier cells whose rowspan covers it contribute their
/// colspan) + its own colspans; the table takes the max. Floors at 1 when rows
/// exist so an all-empty-rows table still rectifies to one seedable column
/// (rows-empty ≠ table-empty: `normalize_table` only drops a table with no
/// rows at all).
fn find_width(rows: &[PmNode]) -> usize {
    let mut width = 0usize;
    for (r, row) in rows.iter().enumerate() {
        let mut row_width = 0usize;
        for (j, prev) in rows.iter().enumerate().take(r) {
            for child in &prev.children {
                if let PmChild::Node(cell) = child {
                    let (cs, rs) = cell_spans(cell);
                    if j + rs > r {
                        row_width += cs;
                    }
                }
            }
        }
        for child in &row.children {
            if let PmChild::Node(cell) = child {
                row_width += cell_spans(cell).0;
            }
        }
        width = width.max(row_width);
    }
    width.max(1)
}

/// Rectify a table's rows in place into a rectangular-with-spans grid:
///
/// - garbage / non-positive span attrs reset to the default (attr removed);
/// - malformed `colwidth` dropped;
/// - a rowspan running past the last row is clamped (`fixTable`
///   overlong_rowspan);
/// - a cell whose rectangle collides with an earlier cell's coverage shrinks
///   its colspan to the free prefix, splicing `colwidth` like PM's
///   `removeColSpan` (tail entries removed; an all-zero remainder is dropped);
/// - `colwidth` whose length ≠ the final colspan is dropped;
/// - rows with free slots left over are padded AT THE END with empty cells of
///   the row's role. A row fully covered by rowspans from above legitimately
///   keeps zero own cells and is NOT padded.
///
/// Returns `(width, changed)`. Idempotent: a second pass changes nothing.
pub(super) fn rectify_table_rows(rows: &mut [PmNode]) -> (usize, bool) {
    let mut changed = false;

    // Pass 0: normalize span/colwidth attrs cell-by-cell (grid math below
    // trusts `cell_spans`; here we make the stored attrs match it).
    for row in rows.iter_mut() {
        for child in row.children.iter_mut() {
            let PmChild::Node(cell) = child else { continue };
            if cell.node_type != "tableCell" && cell.node_type != "tableHeader" {
                continue;
            }
            for attr in ["colspan", "rowspan"] {
                if let Some(raw) = get_attr(cell, attr) {
                    let sane = raw.trim().parse::<i64>().map(|n| n >= 1).unwrap_or(false);
                    if !sane {
                        remove_attr(cell, attr);
                        changed = true;
                    }
                }
            }
            if get_attr(cell, "colwidth").is_some() && cell_colwidth(cell).is_none() {
                remove_attr(cell, "colwidth");
                changed = true;
            }
        }
    }

    let width = find_width(rows);
    let height = rows.len();
    // Occupancy: one slot per (row, col); true = covered by some cell.
    let mut taken = vec![false; width * height];

    for r in 0..height {
        let mut cursor = 0usize; // next candidate column in row r
        let row_role = row_pad_role(&rows[r]);
        for child in rows[r].children.iter_mut() {
            let PmChild::Node(cell) = child else { continue };
            if cell.node_type != "tableCell" && cell.node_type != "tableHeader" {
                continue;
            }
            let (mut colspan, mut rowspan) = cell_spans(cell);

            // Overlong rowspan → clamp to the rows that exist (fixTable parity).
            if r + rowspan > height {
                rowspan = height - r;
                if rowspan <= 1 {
                    remove_attr(cell, "rowspan");
                } else {
                    set_attr(cell, "rowspan", rowspan.to_string());
                }
                changed = true;
            }

            // Anchor column: first free slot in this row.
            while cursor < width && taken[r * width + cursor] {
                cursor += 1;
            }
            if cursor >= width {
                // No capacity left (only reachable through pathological inputs
                // find_width already sized for — defensive): degrade the cell
                // to 1×1 and give the row an extra column by clamping below.
                // In practice find_width guarantees a free slot for every own
                // cell, so this branch is unreachable; keep the cell's content
                // safe rather than panic.
                cursor = width.saturating_sub(1);
            }
            let anchor = cursor;

            // Clamp colspan to the table edge, then shrink to the free prefix
            // across EVERY covered layer (collision → removeColSpan parity:
            // the later cell yields, freed slots pad at the row end).
            colspan = colspan.min(width - anchor);
            let mut free_prefix = 0usize;
            'cols: for w in 0..colspan {
                for h in 0..rowspan {
                    if taken[(r + h) * width + anchor + w] {
                        break 'cols;
                    }
                }
                free_prefix += 1;
            }
            let placed_span = free_prefix.max(1);
            if placed_span != cell_spans(cell).0 {
                // Splice colwidth like removeColSpan: keep the first
                // `placed_span` entries, drop the value entirely when nothing
                // positive remains.
                if let Some(widths) = cell_colwidth(cell) {
                    let kept: Vec<u32> = widths.into_iter().take(placed_span).collect();
                    if kept.iter().any(|w| *w > 0) {
                        set_attr(
                            cell,
                            "colwidth",
                            kept.iter().map(|w| w.to_string()).collect::<Vec<_>>().join(","),
                        );
                    } else {
                        remove_attr(cell, "colwidth");
                    }
                }
                if placed_span <= 1 {
                    remove_attr(cell, "colspan");
                } else {
                    set_attr(cell, "colspan", placed_span.to_string());
                }
                changed = true;
            }
            colspan = placed_span;

            // colwidth length must match the final colspan (PM invariant:
            // one width per spanned column) — otherwise drop it.
            if let Some(widths) = cell_colwidth(cell) {
                if widths.len() != colspan {
                    remove_attr(cell, "colwidth");
                    changed = true;
                }
            }

            for h in 0..rowspan {
                for w in 0..colspan {
                    taken[(r + h) * width + anchor + w] = true;
                }
            }
            cursor = anchor + colspan;
        }

        // Pad the row's remaining FREE slots (covered slots are full). A row
        // whose slots are all covered by rowspans keeps zero own cells.
        let free = (0..width).filter(|c| !taken[r * width + c]).count();
        for _ in 0..free {
            rows[r].children.push(PmChild::Node(empty_cell_of(row_role)));
            changed = true;
        }
        for c in 0..width {
            taken[r * width + c] = true;
        }
    }

    (width, changed)
}

// ---- the strict resolved grid (MCP table verbs, Slice D-3) --------------------

/// One anchor cell's placement in the resolved grid.
#[derive(Debug, Clone, PartialEq)]
pub struct GridCell {
    /// Grid coordinates of the cell's top-left slot.
    pub anchor_row: usize,
    pub anchor_col: usize,
    /// Structural indices: which row child of the table, which cell child of
    /// that row (counting only cell nodes).
    pub row_child: usize,
    pub cell_child: usize,
    pub colspan: usize,
    pub rowspan: usize,
}

/// The resolved span-aware grid of a RECTIFIED table. `slots` maps every
/// `(row * width + col)` to an index into `cells` — a merged cell appears in
/// every slot it covers (prosemirror-tables `TableMap` shape).
#[derive(Debug)]
pub struct TableGrid {
    pub width: usize,
    pub height: usize,
    pub cells: Vec<GridCell>,
    slots: Vec<usize>,
}

impl TableGrid {
    /// Build the grid over an already-rectified table node. Errs when the
    /// table would still change under [`rectify_table_rows`] — callers rectify
    /// (via sanitize) first, so a failure here is a logic bug, not bad input.
    pub(super) fn build(table: &PmNode) -> Result<TableGrid, String> {
        let mut probe: Vec<PmNode> = table
            .children
            .iter()
            .filter_map(|c| match c {
                PmChild::Node(n) if n.node_type == "tableRow" => Some(n.clone()),
                _ => None,
            })
            .collect();
        let (width, changed) = rectify_table_rows(&mut probe);
        if changed {
            return Err("ERR_TABLE_UNRECTIFIED: table changed under rectification — sanitize before building a grid".to_string());
        }
        let height = probe.len();
        let mut cells: Vec<GridCell> = Vec::new();
        let mut slots: Vec<Option<usize>> = vec![None; width * height];

        let rows: Vec<&PmNode> = table
            .children
            .iter()
            .filter_map(|c| match c {
                PmChild::Node(n) if n.node_type == "tableRow" => Some(n),
                _ => None,
            })
            .collect();
        for (r, row) in rows.iter().enumerate() {
            let mut cursor = 0usize;
            let mut cell_child = 0usize;
            for child in &row.children {
                let PmChild::Node(cell) = child else { continue };
                if cell.node_type != "tableCell" && cell.node_type != "tableHeader" {
                    continue;
                }
                let (colspan, rowspan) = cell_spans(cell);
                while cursor < width && slots[r * width + cursor].is_some() {
                    cursor += 1;
                }
                let idx = cells.len();
                cells.push(GridCell {
                    anchor_row: r,
                    anchor_col: cursor,
                    row_child: r,
                    cell_child,
                    colspan,
                    rowspan,
                });
                for h in 0..rowspan {
                    for w in 0..colspan {
                        slots[(r + h) * width + cursor + w] = Some(idx);
                    }
                }
                cursor += colspan;
                cell_child += 1;
            }
        }
        let slots: Vec<usize> = slots
            .into_iter()
            .map(|s| s.ok_or_else(|| "ERR_TABLE_UNRECTIFIED: uncovered grid slot".to_string()))
            .collect::<Result<_, _>>()?;
        Ok(TableGrid { width, height, cells, slots })
    }

    /// The cell covering grid slot `(row, col)`, if in range.
    pub fn cell_covering(&self, row: usize, col: usize) -> Option<&GridCell> {
        if row >= self.height || col >= self.width {
            return None;
        }
        self.cells.get(self.slots[row * self.width + col])
    }
}

#[cfg(test)]
mod tests {
    use super::super::prose_parse::html_to_blocks;
    use super::*;

    fn table_rows(html: &str) -> Vec<PmNode> {
        let blocks = html_to_blocks(html);
        let table = blocks.into_iter().find(|n| n.node_type == "table").expect("table");
        table
            .children
            .into_iter()
            .filter_map(|c| match c {
                PmChild::Node(n) if n.node_type == "tableRow" => Some(n),
                _ => None,
            })
            .collect()
    }

    fn row_cell_count(row: &PmNode) -> usize {
        row.children
            .iter()
            .filter(|c| matches!(c, PmChild::Node(n) if n.node_type == "tableCell" || n.node_type == "tableHeader"))
            .count()
    }

    #[test]
    fn merged_rows_are_not_padded() {
        // The 2026-07-11 live bug: row 0's colspan=2 covers the full width; the
        // old child-count normalizer padded a phantom third cell into it.
        let mut rows = table_rows(
            "<table><tr><td colspan=\"2\"><p>wide</p></td></tr>\
             <tr><td><p>a</p></td><td><p>b</p></td></tr></table>",
        );
        let (width, changed) = rectify_table_rows(&mut rows);
        assert_eq!(width, 2);
        assert!(!changed, "a legal merge must not be rewritten");
        assert_eq!(row_cell_count(&rows[0]), 1);
        assert_eq!(row_cell_count(&rows[1]), 2);
    }

    #[test]
    fn rowspan_covered_row_keeps_zero_own_cells() {
        // Row 1's slots are fully covered by the two rowspan cells above it —
        // it legitimately has no own cells and must not be padded.
        let mut rows = table_rows(
            "<table><tr><td rowspan=\"2\"><p>a</p></td><td rowspan=\"2\"><p>b</p></td></tr>\
             <tr></tr></table>",
        );
        let (width, changed) = rectify_table_rows(&mut rows);
        assert_eq!(width, 2);
        assert!(!changed, "covered row must stay empty: {rows:?}");
        assert_eq!(row_cell_count(&rows[1]), 0);
    }

    #[test]
    fn overlong_rowspan_is_clamped() {
        let mut rows = table_rows(
            "<table><tr><td rowspan=\"9\"><p>a</p></td><td><p>b</p></td></tr>\
             <tr><td><p>c</p></td></tr></table>",
        );
        let (_, changed) = rectify_table_rows(&mut rows);
        assert!(changed);
        let PmChild::Node(cell) = &rows[0].children[0] else { panic!() };
        assert_eq!(get_attr(cell, "rowspan"), Some("2"), "rowspan must clamp to the 2 real rows");
        // Idempotent from here.
        let (_, changed2) = rectify_table_rows(&mut rows);
        assert!(!changed2);
    }

    #[test]
    fn colliding_colspan_shrinks_with_colwidth_splice_and_pad() {
        // Row 0: [a, b(rowspan=2)]; row 1: [c(colspan=2, colwidth)]. Width is
        // 3 (row 1 = carry-in 1 + own colspan 2). c anchors at the first free
        // slot (1,0); its second column (1,1) is covered by b's rowspan —
        // collision. removeColSpan parity: c shrinks to the free prefix
        // (colspan 1 → attr dropped), colwidth splices to the kept entry, and
        // both logically-short rows pad at their ends.
        let mut rows = table_rows(
            "<table><tr><td><p>a</p></td><td rowspan=\"2\"><p>b</p></td></tr>\
             <tr><td colspan=\"2\" colwidth=\"100,120\"><p>c</p></td></tr></table>",
        );
        let (width, changed) = rectify_table_rows(&mut rows);
        assert_eq!(width, 3);
        assert!(changed);
        let PmChild::Node(c) = &rows[1].children[0] else { panic!() };
        assert_eq!(get_attr(c, "colspan"), None, "colliding colspan must shrink away: {c:?}");
        assert_eq!(get_attr(c, "colwidth"), Some("100"), "colwidth must splice to the kept span");
        assert_eq!(row_cell_count(&rows[0]), 3, "row 0 pads its free third column");
        assert_eq!(row_cell_count(&rows[1]), 2, "row 1 = shrunk c + one pad (b covers col 1)");
        let (_, changed2) = rectify_table_rows(&mut rows);
        assert!(!changed2, "rectify must be idempotent");
    }

    #[test]
    fn garbage_span_attrs_reset_to_one() {
        let mut rows = table_rows(
            "<table><tr><td colspan=\"banana\"><p>a</p></td><td rowspan=\"0\"><p>b</p></td>\
             <td colspan=\"-3\"><p>c</p></td></tr></table>",
        );
        let (width, changed) = rectify_table_rows(&mut rows);
        assert_eq!(width, 3);
        assert!(changed);
        for child in &rows[0].children {
            let PmChild::Node(cell) = child else { continue };
            assert_eq!(get_attr(cell, "colspan"), None, "garbage colspan must drop: {cell:?}");
            assert_eq!(get_attr(cell, "rowspan"), None, "garbage rowspan must drop: {cell:?}");
        }
    }

    #[test]
    fn colwidth_length_mismatch_and_garbage_are_dropped() {
        let mut rows = table_rows(
            "<table><tr><td colwidth=\"100,120\"><p>one col, two widths</p></td>\
             <td colwidth=\"a,b\"><p>garbage</p></td></tr></table>",
        );
        let (_, changed) = rectify_table_rows(&mut rows);
        assert!(changed);
        for child in &rows[0].children {
            let PmChild::Node(cell) = child else { continue };
            assert_eq!(get_attr(cell, "colwidth"), None, "bad colwidth must drop: {cell:?}");
        }
    }

    #[test]
    fn logically_short_rows_pad_at_end_with_row_role() {
        // Header row is genuinely one slot short (width 2 from row 1) — the pad
        // must be a tableHeader, appended at the end.
        let mut rows = table_rows(
            "<table><tr><th><p>h</p></th></tr>\
             <tr><td><p>a</p></td><td><p>b</p></td></tr></table>",
        );
        let (width, changed) = rectify_table_rows(&mut rows);
        assert_eq!(width, 2);
        assert!(changed);
        assert_eq!(row_cell_count(&rows[0]), 2);
        let PmChild::Node(pad) = &rows[0].children[1] else { panic!() };
        assert_eq!(pad.node_type, "tableHeader", "pad must inherit the row's role");
    }

    #[test]
    fn rectify_is_idempotent_on_spanned_tables() {
        let mut rows = table_rows(
            "<table>\
             <tr><th colspan=\"2\" colwidth=\"100,120\"><p>W</p></th><th><p>C</p></th></tr>\
             <tr><td rowspan=\"2\"><p>tall</p></td><td><p>b</p></td><td><p>c</p></td></tr>\
             <tr><td><p>d</p></td><td><p>e</p></td></tr>\
             </table>",
        );
        let (width, changed) = rectify_table_rows(&mut rows);
        assert_eq!(width, 3);
        assert!(!changed, "a legal spanned table must pass through untouched");
        let snapshot = rows.clone();
        let (_, changed2) = rectify_table_rows(&mut rows);
        assert!(!changed2);
        assert_eq!(rows, snapshot);
    }

    #[test]
    fn all_empty_rows_pad_to_one_column() {
        // rows-empty ≠ table-empty: the old normalize_row seeded one cell per
        // empty row; the grid pass preserves that shape (width floors at 1).
        let mut rows = table_rows("<table><tr></tr><tr></tr></table>");
        let (width, changed) = rectify_table_rows(&mut rows);
        assert_eq!(width, 1);
        assert!(changed);
        assert_eq!(row_cell_count(&rows[0]), 1);
        assert_eq!(row_cell_count(&rows[1]), 1);
    }

    #[test]
    fn grid_build_resolves_coverage() {
        let blocks = html_to_blocks(
            "<table>\
             <tr><th colspan=\"2\"><p>W</p></th><th><p>C</p></th></tr>\
             <tr><td rowspan=\"2\"><p>tall</p></td><td><p>b</p></td><td><p>c</p></td></tr>\
             <tr><td><p>d</p></td><td><p>e</p></td></tr>\
             </table>",
        );
        let table = blocks.iter().find(|n| n.node_type == "table").expect("table");
        let grid = TableGrid::build(table).expect("rectified table must build");
        assert_eq!((grid.width, grid.height), (3, 3));
        assert_eq!(grid.cells.len(), 7);
        // The merged header covers (0,0) and (0,1).
        let w = grid.cell_covering(0, 0).unwrap();
        assert_eq!((w.anchor_row, w.anchor_col, w.colspan), (0, 0, 2));
        assert_eq!(grid.cell_covering(0, 1).unwrap().anchor_col, 0);
        // The rowspan cell covers (1,0) and (2,0).
        let tall = grid.cell_covering(2, 0).unwrap();
        assert_eq!((tall.anchor_row, tall.rowspan), (1, 2));
        // Row 2's own first cell sits at grid col 1, child index 0.
        let d = grid.cell_covering(2, 1).unwrap();
        assert_eq!((d.row_child, d.cell_child), (2, 0));
        // Out of range → None.
        assert!(grid.cell_covering(3, 0).is_none());
    }

    #[test]
    fn grid_build_rejects_unrectified_tables() {
        let blocks = html_to_blocks(
            "<table><tr><td><p>a</p></td></tr><tr><td><p>b</p></td><td><p>c</p></td></tr></table>",
        );
        let table = blocks.iter().find(|n| n.node_type == "table").expect("table");
        let err = TableGrid::build(table).unwrap_err();
        assert!(err.starts_with("ERR_TABLE_UNRECTIFIED"), "{err}");
    }
}
