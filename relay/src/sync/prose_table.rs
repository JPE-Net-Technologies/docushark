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

// ---- MCP table verbs (Slice D-3): selector, ops, agent-facing grid view -------

use super::prose_block::{anchor_to_text, normalize, pm_node_text, TargetSpec};
use super::prose_validate::{sanitize_blocks, ProseFix};
use serde::Serialize;

/// How the caller names the table on the page.
#[derive(Debug, Clone, Copy)]
pub enum TableSel<'a> {
    /// The page's only table (errors when there are zero or several).
    Sole,
    /// The nth table in document order (nested tables counted where they
    /// appear in the walk).
    Index(usize),
    /// The table CONTAINING the leaf this spec resolves to — the same
    /// id/anchor addressing every other prose verb uses.
    Target(TargetSpec<'a>),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Side {
    Before,
    After,
}

/// One table operation. All coordinates are 0-based SPAN-AWARE grid slots
/// (`get_table`'s model): a merged cell is addressable through any slot it
/// covers. Out-of-range coordinates are hard errors, never clamps — an agent
/// holding a stale grid must re-read.
#[derive(Debug, Clone)]
pub enum TableOp {
    AddRow { row: usize, side: Side },
    AddColumn { col: usize, side: Side },
    DeleteRow { row: usize },
    DeleteColumn { col: usize },
    /// Merge the rectangle bounded by the cells covering the two coords
    /// (prosemirror-tables `mergeCells` parity: top-left anchor keeps its
    /// attrs, non-empty content concatenates, covered cells are removed).
    MergeCells { from: (usize, usize), to: (usize, usize) },
    /// Split a merged cell back into 1×1 cells (content stays on the anchor).
    SplitCell { at: (usize, usize) },
    /// Set/clear presentation attrs on the covering cell (`Some("")` clears).
    SetCellAttrs {
        at: (usize, usize),
        background_color: Option<String>,
        align: Option<String>,
        scope: Option<String>,
    },
    /// Reorder rows/columns. Refused on tables with any merged cell (the
    /// editor's own move commands carry the same guard).
    MoveRow { from: usize, to: usize },
    MoveColumn { from: usize, to: usize },
    ToggleHeaderRow,
    ToggleHeaderColumn,
    /// Set (or clear, `None`/`Some(0)`) one column's width across every cell
    /// covering it — the relay twin of the editor's column-resize drag.
    SetColumnWidth { col: usize, width: Option<u32> },
}

/// Agent-facing resolved grid.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridView {
    pub table_index: usize,
    pub table_count: usize,
    pub rows: usize,
    pub cols: usize,
    pub cells: Vec<CellView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellView {
    pub row: usize,
    pub col: usize,
    /// `"td"` | `"th"`.
    pub tag: String,
    pub colspan: usize,
    pub rowspan: usize,
    /// Normalized text, truncated to 120 chars with a trailing ellipsis.
    pub text: String,
    /// The first in-cell leaf's durable block id (JP-432 Pillar C) — the
    /// handle `set_prose`/`insert_block` can edit the cell's content through.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colwidth: Option<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// Everything an `edit_table` write needs back: the rewritten page HTML, the
/// post-op grid, and any JP-328 fixes sanitize applied while parsing.
#[derive(Debug)]
pub struct TableEditOutcome {
    pub html: String,
    pub grid: GridView,
    pub fixes: Vec<ProseFix>,
}

/// READ: parse + sanitize the page, resolve the selector, return the grid.
pub fn table_grid_in_html(html: &str, sel: &TableSel) -> Result<GridView, String> {
    let (blocks, _) = sanitize_blocks(super::prose_parse::html_to_blocks(html));
    let paths = table_paths(&blocks);
    let index = resolve_table_sel(&blocks, &paths, sel)?;
    let table = node_at_path(&blocks, &paths[index]).expect("path from walk");
    grid_view(table, index, paths.len())
}

/// WRITE transform: parse + sanitize (fixes captured), resolve, apply one op,
/// re-serialize the whole page. The caller routes the HTML through the id fill
/// + live-or-cold page write (the `restructure_outline` shape).
pub fn edit_table_in_html(
    html: &str,
    sel: &TableSel,
    op: &TableOp,
) -> Result<TableEditOutcome, String> {
    let (mut blocks, fixes) = sanitize_blocks(super::prose_parse::html_to_blocks(html));
    let paths = table_paths(&blocks);
    let index = resolve_table_sel(&blocks, &paths, sel)?;
    let table = node_at_path_mut(&mut blocks, &paths[index]).expect("path from walk");
    apply_table_op(table, op)?;
    let grid = grid_view(table, index, paths.len())?;
    Ok(TableEditOutcome {
        html: super::prose_ids::blocks_to_html(&blocks),
        grid,
        fixes,
    })
}

// ---- selector resolution ------------------------------------------------------

/// Child-index paths (from the block roots) of every `table` node, document
/// order, nested tables included where the walk meets them.
fn table_paths(blocks: &[PmNode]) -> Vec<Vec<usize>> {
    let mut out = Vec::new();
    for (i, node) in blocks.iter().enumerate() {
        walk_tables(node, &mut vec![i], &mut out);
    }
    out
}

fn walk_tables(node: &PmNode, path: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
    if node.node_type == "table" {
        out.push(path.clone());
    }
    for (i, child) in node.children.iter().enumerate() {
        if let PmChild::Node(n) = child {
            path.push(i);
            walk_tables(n, path, out);
            path.pop();
        }
    }
}

fn node_at_path<'a>(blocks: &'a [PmNode], path: &[usize]) -> Option<&'a PmNode> {
    let (first, rest) = path.split_first()?;
    let mut node = blocks.get(*first)?;
    for idx in rest {
        node = match node.children.get(*idx)? {
            PmChild::Node(n) => n,
            PmChild::Text { .. } => return None,
        };
    }
    Some(node)
}

fn node_at_path_mut<'a>(blocks: &'a mut [PmNode], path: &[usize]) -> Option<&'a mut PmNode> {
    let (first, rest) = path.split_first()?;
    let mut node = blocks.get_mut(*first)?;
    for idx in rest {
        node = match node.children.get_mut(*idx)? {
            PmChild::Node(n) => n,
            PmChild::Text { .. } => return None,
        };
    }
    Some(node)
}

/// Resolve a [`TableSel`] to an index into `paths`.
fn resolve_table_sel(
    blocks: &[PmNode],
    paths: &[Vec<usize>],
    sel: &TableSel,
) -> Result<usize, String> {
    if paths.is_empty() {
        return Err("ERR_TABLE_NOT_FOUND: the page has no table".to_string());
    }
    match sel {
        TableSel::Sole => {
            if paths.len() > 1 {
                Err(format!(
                    "ERR_TABLE_AMBIGUOUS: the page has {} tables — pass tableIndex (0-based, document order) or an anchor/id inside the table",
                    paths.len()
                ))
            } else {
                Ok(0)
            }
        }
        TableSel::Index(i) => {
            if *i >= paths.len() {
                Err(format!(
                    "ERR_TABLE_INDEX: tableIndex {} out of range — the page has {} table(s)",
                    i,
                    paths.len()
                ))
            } else {
                Ok(*i)
            }
        }
        TableSel::Target(spec) => resolve_target_table(blocks, paths, spec),
    }
}

/// Leaf hits for target resolution: `(table_index_containing_it_or_None, id, text)`.
fn collect_leaf_hits(
    blocks: &[PmNode],
    paths: &[Vec<usize>],
) -> Vec<(Option<usize>, Option<String>, String)> {
    fn walk(
        node: &PmNode,
        path: &mut Vec<usize>,
        paths: &[Vec<usize>],
        table: Option<usize>,
        out: &mut Vec<(Option<usize>, Option<String>, String)>,
    ) {
        let table = if node.node_type == "table" {
            paths.iter().position(|p| p == path)
        } else {
            table
        };
        if super::prose_block::TEXT_LEAVES.contains(&node.node_type.as_str()) {
            let mut text = String::new();
            pm_node_text(node, &mut text);
            let id = get_attr(node, "id").filter(|s| !s.is_empty()).map(String::from);
            out.push((table, id, normalize(&text)));
            return;
        }
        for (i, child) in node.children.iter().enumerate() {
            if let PmChild::Node(n) = child {
                path.push(i);
                walk(n, path, paths, table, out);
                path.pop();
            }
        }
    }
    let mut out = Vec::new();
    for (i, node) in blocks.iter().enumerate() {
        walk(node, &mut vec![i], paths, None, &mut out);
    }
    out
}

/// The table containing the leaf a [`TargetSpec`] names — id semantics mirror
/// `prose_block::resolve_spec` (stale id fails hard, id+anchor must agree).
fn resolve_target_table(
    blocks: &[PmNode],
    paths: &[Vec<usize>],
    spec: &TargetSpec<'_>,
) -> Result<usize, String> {
    let hits = collect_leaf_hits(blocks, paths);

    let table_for = |matches: Vec<&(Option<usize>, Option<String>, String)>,
                     kind: &str|
     -> Result<usize, String> {
        let mut tables: Vec<Option<usize>> = matches.iter().map(|(t, _, _)| *t).collect();
        tables.dedup();
        if tables.iter().any(|t| t.is_none()) {
            return Err(format!(
                "ERR_TARGET_NOT_IN_TABLE: the {kind} matches content outside any table"
            ));
        }
        let mut distinct: Vec<usize> = tables.into_iter().flatten().collect();
        distinct.sort_unstable();
        distinct.dedup();
        if distinct.len() > 1 {
            return Err(format!(
                "ERR_TABLE_AMBIGUOUS: the {kind} matches content in {} different tables",
                distinct.len()
            ));
        }
        Ok(distinct[0])
    };

    let by_id = match spec.id {
        Some(id) => {
            let matches: Vec<_> =
                hits.iter().filter(|(_, i, _)| i.as_deref() == Some(id)).collect();
            if matches.is_empty() {
                return Err(format!(
                    "ERR_ID_NOT_FOUND: no block with id '{id}' on this page — re-read with get_prose/get_table (the id may be stale)"
                ));
            }
            Some(table_for(matches, "id")?)
        }
        None => None,
    };
    let by_anchor = match spec.anchor {
        Some(anchor) => {
            let wanted = normalize(&anchor_to_text(anchor));
            if wanted.is_empty() {
                return Err("ERR_ANCHOR_EMPTY: anchor has no text".to_string());
            }
            let matches: Vec<_> = hits.iter().filter(|(_, _, t)| *t == wanted).collect();
            if matches.is_empty() {
                return Err(format!(
                    "ERR_ANCHOR_NOT_FOUND: no block matches anchor '{anchor}'"
                ));
            }
            Some(table_for(matches, "anchor")?)
        }
        None => None,
    };
    match (by_id, by_anchor) {
        (Some(a), Some(b)) if a != b => Err(
            "ERR_ID_ANCHOR_MISMATCH: the id and the anchor resolve to different tables — re-read and pass a current pair"
                .to_string(),
        ),
        (Some(t), _) | (None, Some(t)) => Ok(t),
        (None, None) => Err(
            "ERR_TARGET_MISSING: pass tableIndex, or an anchor/id of content inside the table"
                .to_string(),
        ),
    }
}

// ---- grid view ----------------------------------------------------------------

fn cell_text(cell: &PmNode) -> String {
    // Per-block texts joined with a space, so a merged cell holding several
    // paragraphs reads "a c d" rather than "acd".
    let mut parts: Vec<String> = Vec::new();
    for child in &cell.children {
        if let PmChild::Node(n) = child {
            let mut text = String::new();
            pm_node_text(n, &mut text);
            let t = normalize(&text);
            if !t.is_empty() {
                parts.push(t);
            }
        }
    }
    let mut t = parts.join(" ");
    if t.chars().count() > 120 {
        t = t.chars().take(120).collect::<String>() + "…";
    }
    t
}

fn first_leaf_id(node: &PmNode) -> Option<String> {
    if super::prose_block::TEXT_LEAVES.contains(&node.node_type.as_str()) {
        return get_attr(node, "id").filter(|s| !s.is_empty()).map(String::from);
    }
    for child in &node.children {
        if let PmChild::Node(n) = child {
            if let Some(id) = first_leaf_id(n) {
                return Some(id);
            }
        }
    }
    None
}

fn grid_view(table: &PmNode, table_index: usize, table_count: usize) -> Result<GridView, String> {
    let grid = TableGrid::build(table)?;
    let mut cells = Vec::with_capacity(grid.cells.len());
    for gc in &grid.cells {
        let cell = cell_node(table, gc.row_child, gc.cell_child)
            .ok_or_else(|| "ERR_TABLE_UNRECTIFIED: grid/table drift".to_string())?;
        cells.push(CellView {
            row: gc.anchor_row,
            col: gc.anchor_col,
            tag: if cell.node_type == "tableHeader" { "th" } else { "td" }.to_string(),
            colspan: gc.colspan,
            rowspan: gc.rowspan,
            text: cell_text(cell),
            id: first_leaf_id(cell),
            colwidth: cell_colwidth(cell),
            background_color: get_attr(cell, "backgroundColor").map(String::from),
            align: get_attr(cell, "align").map(String::from),
            scope: get_attr(cell, "scope").map(String::from),
        });
    }
    Ok(GridView {
        table_index,
        table_count,
        rows: grid.height,
        cols: grid.width,
        cells,
    })
}

// ---- op application -----------------------------------------------------------

fn is_cell(n: &PmNode) -> bool {
    n.node_type == "tableCell" || n.node_type == "tableHeader"
}

fn row_node(table: &PmNode, r: usize) -> Option<&PmNode> {
    match table.children.get(r) {
        Some(PmChild::Node(n)) if n.node_type == "tableRow" => Some(n),
        _ => None,
    }
}

fn row_node_mut(table: &mut PmNode, r: usize) -> Option<&mut PmNode> {
    match table.children.get_mut(r) {
        Some(PmChild::Node(n)) if n.node_type == "tableRow" => Some(n),
        _ => None,
    }
}

fn cell_node(table: &PmNode, r: usize, c: usize) -> Option<&PmNode> {
    match row_node(table, r)?.children.get(c) {
        Some(PmChild::Node(n)) if is_cell(n) => Some(n),
        _ => None,
    }
}

fn cell_node_mut(table: &mut PmNode, r: usize, c: usize) -> Option<&mut PmNode> {
    match row_node_mut(table, r)?.children.get_mut(c) {
        Some(PmChild::Node(n)) if is_cell(n) => Some(n),
        _ => None,
    }
}

/// PM `isEmpty` parity: exactly one empty paragraph (attrs ignored).
fn cell_is_empty(cell: &PmNode) -> bool {
    match cell.children.as_slice() {
        [PmChild::Node(p)] => p.node_type == "paragraph" && p.children.is_empty(),
        _ => false,
    }
}

fn set_span_attr(cell: &mut PmNode, name: &str, value: usize) {
    if value <= 1 {
        remove_attr(cell, name);
    } else {
        set_attr(cell, name, value.to_string());
    }
}

fn set_colwidth_attr(cell: &mut PmNode, widths: Option<Vec<u32>>) {
    match widths {
        Some(w) if w.iter().any(|x| *x > 0) => set_attr(
            cell,
            "colwidth",
            w.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","),
        ),
        _ => remove_attr(cell, "colwidth"),
    }
}

/// The first `colwidth` value any cell records for grid column `col`, if one
/// exists — used to seed new cells so the editor's `fixTables` consensus pass
/// has nothing to rewrite when it opens the doc.
fn column_width_consensus(table: &PmNode, grid: &TableGrid, col: usize) -> Option<u32> {
    for gc in &grid.cells {
        if col < gc.anchor_col || col >= gc.anchor_col + gc.colspan {
            continue;
        }
        if let Some(w) = cell_node(table, gc.row_child, gc.cell_child).and_then(cell_colwidth) {
            let v = w.get(col - gc.anchor_col).copied().unwrap_or(0);
            if v > 0 {
                return Some(v);
            }
        }
    }
    None
}

fn check_coord(grid: &TableGrid, row: usize, col: usize) -> Result<(), String> {
    if row >= grid.height || col >= grid.width {
        return Err(format!(
            "ERR_CELL_RANGE: ({row}, {col}) outside the {}×{} grid — re-read with get_table",
            grid.height, grid.width
        ));
    }
    Ok(())
}

fn table_has_merges(grid: &TableGrid) -> bool {
    grid.cells.iter().any(|c| c.colspan > 1 || c.rowspan > 1)
}

/// The child index in row `r` where a cell anchored at grid column `col`
/// belongs: after every existing cell of that row anchored left of `col`.
fn insert_index_for_col(grid: &TableGrid, r: usize, col: usize) -> usize {
    grid.cells
        .iter()
        .filter(|c| c.row_child == r && c.anchor_col < col)
        .count()
}

/// Apply one op to a RECTIFIED table node, in place. Errors leave the node
/// untouched (validation happens against the grid before any mutation); a
/// post-op re-rectification acts as an internal invariant check — an op that
/// would emit a broken table is refused, never silently "healed".
pub(super) fn apply_table_op(table: &mut PmNode, op: &TableOp) -> Result<(), String> {
    let grid = TableGrid::build(table)?;
    match op {
        TableOp::AddRow { row, side } => {
            check_coord(&grid, *row, 0)?;
            let boundary = if *side == Side::Before { *row } else { *row + 1 };
            let mut new_cells: Vec<PmChild> = Vec::new();
            let mut col = 0usize;
            while col < grid.width {
                let crossing = (boundary > 0 && boundary < grid.height)
                    .then(|| grid.cell_covering(boundary - 1, col))
                    .flatten()
                    .filter(|c| c.anchor_row + c.rowspan > boundary)
                    .cloned();
                if let Some(c) = crossing {
                    // A cell spanning the insertion boundary grows through the
                    // new row instead of the row gaining a cell there.
                    let cell = cell_node_mut(table, c.row_child, c.cell_child).expect("grid ref");
                    set_span_attr(cell, "rowspan", c.rowspan + 1);
                    col = c.anchor_col + c.colspan;
                } else {
                    let mut cell = empty_cell_of("tableCell");
                    if let Some(w) = column_width_consensus(table, &grid, col) {
                        set_colwidth_attr(&mut cell, Some(vec![w]));
                    }
                    new_cells.push(PmChild::Node(cell));
                    col += 1;
                }
            }
            let new_row = PmNode {
                node_type: "tableRow".to_string(),
                attrs: vec![],
                children: new_cells,
            };
            table.children.insert(boundary, PmChild::Node(new_row));
        }
        TableOp::DeleteRow { row } => {
            check_coord(&grid, *row, 0)?;
            if grid.height == 1 {
                return Err("ERR_TABLE_LAST_ROW: a table needs at least one row — delete the table content via set_prose instead".to_string());
            }
            // Cells from above spanning through the row shrink; cells anchored
            // in the row with a remainder move down into the next row.
            let mut movers: Vec<(usize, PmNode)> = Vec::new();
            for gc in grid.cells.iter().filter(|c| c.anchor_row <= *row) {
                if gc.anchor_row < *row && gc.anchor_row + gc.rowspan > *row {
                    let cell = cell_node_mut(table, gc.row_child, gc.cell_child).expect("grid ref");
                    set_span_attr(cell, "rowspan", gc.rowspan - 1);
                } else if gc.anchor_row == *row && gc.rowspan > 1 {
                    let cell = cell_node(table, gc.row_child, gc.cell_child).expect("grid ref");
                    let mut moved = cell.clone();
                    set_span_attr(&mut moved, "rowspan", gc.rowspan - 1);
                    movers.push((gc.anchor_col, moved));
                }
            }
            table.children.remove(*row);
            if !movers.is_empty() {
                // Merge the movers into what is now row `row` (the old row+1)
                // by anchor column: pair the destination row's existing cells
                // with their grid columns (same order), then rebuild sorted.
                let dest_cols: Vec<usize> = grid
                    .cells
                    .iter()
                    .filter(|c| c.row_child == *row + 1)
                    .map(|c| c.anchor_col)
                    .collect();
                let dest = row_node_mut(table, *row).ok_or("ERR_CELL_RANGE: row vanished")?;
                let mut merged: Vec<(usize, PmChild)> = dest_cols
                    .iter()
                    .copied()
                    .zip(std::mem::take(&mut dest.children))
                    .collect();
                merged.extend(movers.into_iter().map(|(col, n)| (col, PmChild::Node(n))));
                merged.sort_by_key(|(col, _)| *col);
                dest.children = merged.into_iter().map(|(_, n)| n).collect();
            }
        }
        TableOp::AddColumn { col, side } => {
            check_coord(&grid, 0, *col)?;
            let boundary = if *side == Side::Before { *col } else { *col + 1 };
            // Cells spanning the vertical boundary grow colspan once (at their
            // anchor); every other row gains a fresh cell of the row's role.
            let mut grown: Vec<(usize, usize)> = Vec::new();
            for r in 0..grid.height {
                let crossing = (boundary > 0 && boundary < grid.width)
                    .then(|| grid.cell_covering(r, boundary - 1))
                    .flatten()
                    .filter(|c| c.anchor_col + c.colspan > boundary)
                    .cloned();
                if let Some(c) = crossing {
                    if grown.contains(&(c.row_child, c.cell_child)) {
                        continue;
                    }
                    let cell = cell_node_mut(table, c.row_child, c.cell_child).expect("grid ref");
                    let widths = cell_colwidth(cell).map(|mut w| {
                        w.insert(boundary - c.anchor_col, 0);
                        w
                    });
                    set_span_attr(cell, "colspan", c.colspan + 1);
                    if let Some(w) = widths {
                        set_colwidth_attr(cell, Some(w));
                    }
                    grown.push((c.row_child, c.cell_child));
                } else {
                    let role = row_node(table, r).map(row_pad_role).unwrap_or("tableCell");
                    let idx = insert_index_for_col(&grid, r, boundary);
                    let row = row_node_mut(table, r).ok_or("ERR_CELL_RANGE: row vanished")?;
                    row.children
                        .insert(idx.min(row.children.len()), PmChild::Node(empty_cell_of(role)));
                }
            }
        }
        TableOp::DeleteColumn { col } => {
            check_coord(&grid, 0, *col)?;
            if grid.width == 1 {
                return Err("ERR_TABLE_LAST_COLUMN: a table needs at least one column — delete the table content via set_prose instead".to_string());
            }
            // Process each covering anchor once, bottom-up per row so child
            // indices stay valid while removing.
            let mut seen: Vec<(usize, usize)> = Vec::new();
            let mut removals: Vec<(usize, usize)> = Vec::new();
            for r in 0..grid.height {
                let Some(gc) = grid.cell_covering(r, *col).cloned() else { continue };
                if seen.contains(&(gc.row_child, gc.cell_child)) {
                    continue;
                }
                seen.push((gc.row_child, gc.cell_child));
                if gc.colspan > 1 {
                    let cell = cell_node_mut(table, gc.row_child, gc.cell_child).expect("grid ref");
                    let widths = cell_colwidth(cell).map(|mut w| {
                        w.remove(*col - gc.anchor_col);
                        w
                    });
                    set_span_attr(cell, "colspan", gc.colspan - 1);
                    set_colwidth_attr(cell, widths);
                } else {
                    removals.push((gc.row_child, gc.cell_child));
                }
            }
            removals.sort_unstable_by(|a, b| b.cmp(a));
            for (r, c) in removals {
                let row = row_node_mut(table, r).ok_or("ERR_CELL_RANGE: row vanished")?;
                row.children.remove(c);
            }
        }
        TableOp::MergeCells { from, to } => {
            check_coord(&grid, from.0, from.1)?;
            check_coord(&grid, to.0, to.1)?;
            let a = grid.cell_covering(from.0, from.1).expect("checked").clone();
            let b = grid.cell_covering(to.0, to.1).expect("checked").clone();
            let top = a.anchor_row.min(b.anchor_row);
            let left = a.anchor_col.min(b.anchor_col);
            let bottom = (a.anchor_row + a.rowspan).max(b.anchor_row + b.rowspan);
            let right = (a.anchor_col + a.colspan).max(b.anchor_col + b.colspan);
            if (bottom - top, right - left) == (1, 1) {
                return Err("ERR_MERGE_SINGLE_CELL: from/to cover a single cell — nothing to merge".to_string());
            }
            // Every cell intersecting the rectangle must lie fully inside it.
            let mut members: Vec<(usize, usize)> = Vec::new();
            for gc in &grid.cells {
                let inter = gc.anchor_row < bottom
                    && gc.anchor_row + gc.rowspan > top
                    && gc.anchor_col < right
                    && gc.anchor_col + gc.colspan > left;
                if !inter {
                    continue;
                }
                let inside = gc.anchor_row >= top
                    && gc.anchor_row + gc.rowspan <= bottom
                    && gc.anchor_col >= left
                    && gc.anchor_col + gc.colspan <= right;
                if !inside {
                    return Err("ERR_MERGE_PARTIAL_SPAN: the rectangle cuts through a merged cell — merge or split it first".to_string());
                }
                members.push((gc.row_child, gc.cell_child));
            }
            let anchor_ref = grid.cell_covering(top, left).expect("rect corner").clone();
            let anchor_key = (anchor_ref.row_child, anchor_ref.cell_child);
            // Concatenate non-empty content (anchor first, PM parity: an empty
            // anchor is REPLACED by the first non-empty content, not prefixed).
            let mut merged_children: Vec<PmChild> = Vec::new();
            for (r, c) in &members {
                let cell = cell_node(table, *r, *c).expect("member");
                if !cell_is_empty(cell) {
                    merged_children.extend(cell.children.iter().cloned());
                }
            }
            if merged_children.is_empty() {
                merged_children = empty_cell_of("tableCell").children;
            }
            // colwidth: keep the anchor's, spliced with 0s for gained columns
            // (addColSpan parity).
            let anchor_cell = cell_node(table, anchor_key.0, anchor_key.1).expect("anchor");
            let widths = cell_colwidth(anchor_cell).map(|mut w| {
                while w.len() < right - left {
                    w.push(0);
                }
                w
            });
            {
                let anchor_cell =
                    cell_node_mut(table, anchor_key.0, anchor_key.1).expect("anchor");
                anchor_cell.children = merged_children;
                set_span_attr(anchor_cell, "colspan", right - left);
                set_span_attr(anchor_cell, "rowspan", bottom - top);
                set_colwidth_attr(anchor_cell, widths);
            }
            let mut removals: Vec<(usize, usize)> =
                members.into_iter().filter(|m| *m != anchor_key).collect();
            removals.sort_unstable_by(|x, y| y.cmp(x));
            for (r, c) in removals {
                let row = row_node_mut(table, r).ok_or("ERR_CELL_RANGE: row vanished")?;
                row.children.remove(c);
            }
        }
        TableOp::SplitCell { at } => {
            check_coord(&grid, at.0, at.1)?;
            let gc = grid.cell_covering(at.0, at.1).expect("checked").clone();
            if gc.colspan == 1 && gc.rowspan == 1 {
                return Err("ERR_SPLIT_NOT_MERGED: the cell at that slot is not merged".to_string());
            }
            let widths = cell_node(table, gc.row_child, gc.cell_child).and_then(cell_colwidth);
            let role = cell_node(table, gc.row_child, gc.cell_child)
                .map(|c| c.node_type.clone())
                .unwrap_or_else(|| "tableCell".to_string());
            {
                let cell = cell_node_mut(table, gc.row_child, gc.cell_child).expect("grid ref");
                set_span_attr(cell, "colspan", 1);
                set_span_attr(cell, "rowspan", 1);
                set_colwidth_attr(cell, widths.as_ref().map(|w| vec![w[0]]));
            }
            // Fill every freed slot with an empty same-role cell (content
            // stays on the anchor — splitCell parity). Row-major; per row,
            // insert cells at the child index their column dictates.
            for r in gc.anchor_row..gc.anchor_row + gc.rowspan {
                let mut at_idx = if r == gc.anchor_row {
                    gc.cell_child + 1
                } else {
                    insert_index_for_col(&grid, r, gc.anchor_col)
                };
                for w in 0..gc.colspan {
                    if r == gc.anchor_row && w == 0 {
                        continue; // the anchor keeps this slot
                    }
                    let mut cell = empty_cell_of(&role);
                    if let Some(cw) = widths.as_ref().and_then(|ws| ws.get(w)).copied() {
                        set_colwidth_attr(&mut cell, Some(vec![cw]));
                    }
                    let row = row_node_mut(table, r).ok_or("ERR_CELL_RANGE: row vanished")?;
                    row.children.insert(at_idx.min(row.children.len()), PmChild::Node(cell));
                    at_idx += 1;
                }
            }
        }
        TableOp::SetCellAttrs { at, background_color, align, scope } => {
            check_coord(&grid, at.0, at.1)?;
            let gc = grid.cell_covering(at.0, at.1).expect("checked").clone();
            let is_header =
                cell_node(table, gc.row_child, gc.cell_child).expect("grid ref").node_type
                    == "tableHeader";
            if matches!(scope, Some(s) if !s.is_empty()) && !is_header {
                return Err("ERR_CELL_ATTR: 'scope' only applies to header cells (th)".to_string());
            }
            let cell = cell_node_mut(table, gc.row_child, gc.cell_child).expect("grid ref");
            for (name, value) in [
                ("backgroundColor", background_color),
                ("align", align),
                ("scope", scope),
            ] {
                match value {
                    Some(v) if v.is_empty() => remove_attr(cell, name),
                    Some(v) => set_attr(cell, name, v.clone()),
                    None => {}
                }
            }
        }
        TableOp::MoveRow { from, to } => {
            check_coord(&grid, *from, 0)?;
            check_coord(&grid, *to, 0)?;
            if table_has_merges(&grid) {
                return Err("ERR_TABLE_HAS_MERGES: row/column moves are not supported on tables with merged cells (split them first)".to_string());
            }
            if from != to {
                let row = table.children.remove(*from);
                table.children.insert(*to, row);
            }
        }
        TableOp::MoveColumn { from, to } => {
            check_coord(&grid, 0, *from)?;
            check_coord(&grid, 0, *to)?;
            if table_has_merges(&grid) {
                return Err("ERR_TABLE_HAS_MERGES: row/column moves are not supported on tables with merged cells (split them first)".to_string());
            }
            if from != to {
                for r in 0..grid.height {
                    let row = row_node_mut(table, r).ok_or("ERR_CELL_RANGE: row vanished")?;
                    let cell = row.children.remove(*from);
                    row.children.insert(*to, cell);
                }
            }
        }
        TableOp::ToggleHeaderRow | TableOp::ToggleHeaderColumn => {
            let is_row = matches!(op, TableOp::ToggleHeaderRow);
            let members: Vec<(usize, usize)> = grid
                .cells
                .iter()
                .filter(|c| if is_row { c.anchor_row == 0 } else { c.anchor_col == 0 })
                .map(|c| (c.row_child, c.cell_child))
                .collect();
            let all_headers = members.iter().all(|(r, c)| {
                cell_node(table, *r, *c).map(|n| n.node_type == "tableHeader").unwrap_or(false)
            });
            for (r, c) in members {
                let cell = cell_node_mut(table, r, c).expect("grid ref");
                if all_headers {
                    cell.node_type = "tableCell".to_string();
                    remove_attr(cell, "scope"); // td carries no scope
                } else {
                    cell.node_type = "tableHeader".to_string();
                }
            }
        }
        TableOp::SetColumnWidth { col, width } => {
            check_coord(&grid, 0, *col)?;
            let mut seen: Vec<(usize, usize)> = Vec::new();
            for r in 0..grid.height {
                let Some(gc) = grid.cell_covering(r, *col).cloned() else { continue };
                if seen.contains(&(gc.row_child, gc.cell_child)) {
                    continue;
                }
                seen.push((gc.row_child, gc.cell_child));
                let cell = cell_node_mut(table, gc.row_child, gc.cell_child).expect("grid ref");
                let mut widths = cell_colwidth(cell).unwrap_or_else(|| vec![0; gc.colspan]);
                widths.resize(gc.colspan, 0);
                widths[*col - gc.anchor_col] = width.unwrap_or(0);
                set_colwidth_attr(cell, Some(widths));
            }
        }
    }

    // Internal invariant check: an op must leave the table rectified. Refuse
    // (leaving the caller's page unwritten) rather than emit a table the write
    // gate would silently reshape.
    let mut probe: Vec<PmNode> = table
        .children
        .iter()
        .filter_map(|c| match c {
            PmChild::Node(n) if n.node_type == "tableRow" => Some(n.clone()),
            _ => None,
        })
        .collect();
    let (_, changed) = rectify_table_rows(&mut probe);
    if changed {
        return Err("ERR_TABLE_INTERNAL: the op produced an unrectified table — please report this".to_string());
    }
    Ok(())
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

    // ---- Slice D-3: selector + ops through the public entry points ------------

    /// 2 cols: row0 = [a(rowspan=2), b], row1 = [c].
    const TALL: &str = "<table><tr><td rowspan=\"2\"><p>a</p></td><td><p>b</p></td></tr>\
                        <tr><td><p>c</p></td></tr></table>";
    /// row0 = [w(colspan=2)], row1 = [x, y].
    const WIDE: &str = "<table><tr><td colspan=\"2\"><p>w</p></td></tr>\
                        <tr><td><p>x</p></td><td><p>y</p></td></tr></table>";

    fn cell_texts(grid: &GridView) -> Vec<(usize, usize, String)> {
        grid.cells.iter().map(|c| (c.row, c.col, c.text.clone())).collect()
    }

    fn edit(html: &str, op: TableOp) -> TableEditOutcome {
        edit_table_in_html(html, &TableSel::Sole, &op).expect("op should apply")
    }

    #[test]
    fn grid_view_reports_span_aware_cells_with_ids() {
        let html = "<table><tr><th colspan=\"2\" colwidth=\"100,120\"><p id=\"blk-headA\">Wide</p></th><th><p>C</p></th></tr>\
             <tr><td rowspan=\"2\"><p>tall</p></td><td><p>b</p></td><td><p>c</p></td></tr>\
             <tr><td><p>d</p></td><td><p>e</p></td></tr></table>";
        let grid = table_grid_in_html(html, &TableSel::Sole).expect("grid");
        assert_eq!((grid.rows, grid.cols, grid.table_count), (3, 3, 1));
        let wide = &grid.cells[0];
        assert_eq!(
            (wide.row, wide.col, wide.colspan, wide.tag.as_str(), wide.text.as_str()),
            (0, 0, 2, "th", "Wide")
        );
        assert_eq!(wide.id.as_deref(), Some("blk-headA"));
        assert_eq!(wide.colwidth, Some(vec![100, 120]));
        let tall = grid.cells.iter().find(|c| c.text == "tall").unwrap();
        assert_eq!((tall.row, tall.col, tall.rowspan, tall.tag.as_str()), (1, 0, 2, "td"));
    }

    #[test]
    fn selector_errors_and_addressing() {
        assert!(table_grid_in_html("<p>no tables</p>", &TableSel::Sole)
            .unwrap_err()
            .starts_with("ERR_TABLE_NOT_FOUND"));

        let two = "<table><tr><td><p>first</p></td></tr></table>\
                   <p>between</p>\
                   <table><tr><td><p>second</p></td></tr></table>";
        assert!(table_grid_in_html(two, &TableSel::Sole)
            .unwrap_err()
            .starts_with("ERR_TABLE_AMBIGUOUS"));
        let g1 = table_grid_in_html(two, &TableSel::Index(1)).expect("index");
        assert_eq!(g1.cells[0].text, "second");
        assert!(table_grid_in_html(two, &TableSel::Index(2))
            .unwrap_err()
            .starts_with("ERR_TABLE_INDEX"));

        let by_anchor =
            table_grid_in_html(two, &TableSel::Target(TargetSpec::text("second"))).expect("anchor");
        assert_eq!(by_anchor.table_index, 1);
        assert!(table_grid_in_html(two, &TableSel::Target(TargetSpec::text("between")))
            .unwrap_err()
            .starts_with("ERR_TARGET_NOT_IN_TABLE"));
        assert!(table_grid_in_html(two, &TableSel::Target(TargetSpec::by_id("blk-stale")))
            .unwrap_err()
            .starts_with("ERR_ID_NOT_FOUND"));

        let dup = "<table><tr><td><p>same</p></td></tr></table>\
                   <table><tr><td><p>same</p></td></tr></table>";
        assert!(table_grid_in_html(dup, &TableSel::Target(TargetSpec::text("same")))
            .unwrap_err()
            .starts_with("ERR_TABLE_AMBIGUOUS"));
    }

    #[test]
    fn add_row_after_grows_the_crossing_rowspan() {
        let out = edit(TALL, TableOp::AddRow { row: 0, side: Side::After });
        assert_eq!((out.grid.rows, out.grid.cols), (3, 2));
        assert!(out.html.contains("rowspan=\"3\""), "span must grow through the new row: {}", out.html);
        // The new row owns exactly one (fresh) cell — column 0 stays covered.
        assert_eq!(
            out.grid.cells.iter().filter(|c| c.row == 1 && c.col == 1).count(),
            1,
            "{:?}",
            cell_texts(&out.grid)
        );
    }

    #[test]
    fn add_row_at_edges_seeds_colwidth_consensus() {
        let html = "<table><tr><td colwidth=\"100\"><p>a</p></td><td><p>b</p></td></tr></table>";
        let out = edit(html, TableOp::AddRow { row: 0, side: Side::Before });
        assert_eq!(out.grid.rows, 2);
        let new_first = out.grid.cells.iter().find(|c| c.row == 0 && c.col == 0).unwrap();
        assert_eq!(new_first.colwidth, Some(vec![100]), "new cell must adopt the column width");
        assert_eq!(out.grid.cells.iter().find(|c| c.row == 0 && c.col == 1).unwrap().colwidth, None);
    }

    #[test]
    fn delete_row_moves_the_rowspan_remainder_down() {
        let out = edit(TALL, TableOp::DeleteRow { row: 0 });
        assert_eq!((out.grid.rows, out.grid.cols), (1, 2));
        assert_eq!(
            cell_texts(&out.grid),
            vec![(0, 0, "a".to_string()), (0, 1, "c".to_string())],
            "the rowspan remainder must land at its column, before c's old neighbor slot"
        );
        assert!(!out.html.contains("rowspan"), "remainder must be 1x1: {}", out.html);
    }

    #[test]
    fn delete_row_shrinks_a_span_from_above() {
        let out = edit(TALL, TableOp::DeleteRow { row: 1 });
        assert_eq!((out.grid.rows, out.grid.cols), (1, 2));
        assert_eq!(
            cell_texts(&out.grid),
            vec![(0, 0, "a".to_string()), (0, 1, "b".to_string())]
        );
        assert!(!out.html.contains("rowspan"), "{}", out.html);
    }

    #[test]
    fn delete_last_row_and_column_are_refused() {
        let one = "<table><tr><td><p>only</p></td></tr></table>";
        assert!(edit_table_in_html(one, &TableSel::Sole, &TableOp::DeleteRow { row: 0 })
            .unwrap_err()
            .starts_with("ERR_TABLE_LAST_ROW"));
        assert!(edit_table_in_html(one, &TableSel::Sole, &TableOp::DeleteColumn { col: 0 })
            .unwrap_err()
            .starts_with("ERR_TABLE_LAST_COLUMN"));
    }

    #[test]
    fn add_column_grows_the_crossing_colspan_and_inserts_fresh_cells() {
        let out = edit(WIDE, TableOp::AddColumn { col: 0, side: Side::After });
        assert_eq!((out.grid.rows, out.grid.cols), (2, 3));
        assert!(out.html.contains("colspan=\"3\""), "{}", out.html);
        // Row 1 gains an empty cell between x and y.
        assert_eq!(
            cell_texts(&out.grid)
                .into_iter()
                .filter(|(r, _, _)| *r == 1)
                .collect::<Vec<_>>(),
            vec![
                (1, 0, "x".to_string()),
                (1, 1, String::new()),
                (1, 2, "y".to_string())
            ]
        );
    }

    #[test]
    fn delete_column_shrinks_spans_and_removes_single_cells() {
        let out = edit(WIDE, TableOp::DeleteColumn { col: 1 });
        assert_eq!((out.grid.rows, out.grid.cols), (2, 1));
        assert!(!out.html.contains("colspan"), "w must shrink to 1x1: {}", out.html);
        assert_eq!(
            cell_texts(&out.grid),
            vec![(0, 0, "w".to_string()), (1, 0, "x".to_string())],
            "y (a 1x1 covering the deleted column) must be removed"
        );
    }

    #[test]
    fn merge_cells_concatenates_content_and_removes_covered_cells() {
        let html = "<table><tr><td><p>a</p></td><td><p></p></td></tr>\
                    <tr><td><p>c</p></td><td><p>d</p></td></tr></table>";
        let out = edit(html, TableOp::MergeCells { from: (0, 0), to: (1, 1) });
        assert_eq!(out.grid.cells.len(), 1);
        let cell = &out.grid.cells[0];
        assert_eq!((cell.colspan, cell.rowspan), (2, 2));
        assert_eq!(cell.text, "a c d", "empty cell skipped, others concatenated in row-major order");
        assert!(out.html.contains("colspan=\"2\"") && out.html.contains("rowspan=\"2\""), "{}", out.html);
    }

    #[test]
    fn merge_partial_span_is_refused() {
        // 3 cols: row0 = [a, m(colspan=2)], row1 = [c, d, e]. The (0,0)-(1,1)
        // rect (bounding box of two 1×1 cells) intersects m at (0,1) while m
        // extends outside to (0,2) — the PM cellsOverlapRectangle refusal.
        let html = "<table><tr><td><p>a</p></td><td colspan=\"2\"><p>m</p></td></tr>\
                    <tr><td><p>c</p></td><td><p>d</p></td><td><p>e</p></td></tr></table>";
        let err = edit_table_in_html(html, &TableSel::Sole, &TableOp::MergeCells { from: (0, 0), to: (1, 1) })
            .unwrap_err();
        assert!(err.starts_with("ERR_MERGE_PARTIAL_SPAN"), "{err}");
        let single = edit_table_in_html(html, &TableSel::Sole, &TableOp::MergeCells { from: (1, 0), to: (1, 0) })
            .unwrap_err();
        assert!(single.starts_with("ERR_MERGE_SINGLE_CELL"), "{single}");
    }

    #[test]
    fn merge_rect_expands_to_the_covering_cell_like_a_cell_selection() {
        // Naming a slot covered by a merged cell pulls the WHOLE cell into the
        // rect (PM CellSelection parity): (0,1) is covered by m (cols 0-1), so
        // merging to (1,1) produces a 2×2 anchor over cols 0-1.
        let html = "<table><tr><td colspan=\"2\"><p>m</p></td><td><p>b</p></td></tr>\
                    <tr><td><p>c</p></td><td><p>d</p></td><td><p>e</p></td></tr></table>";
        let out = edit(html, TableOp::MergeCells { from: (0, 1), to: (1, 1) });
        let anchor = out.grid.cells.iter().find(|c| (c.row, c.col) == (0, 0)).unwrap();
        assert_eq!((anchor.colspan, anchor.rowspan), (2, 2));
        assert_eq!(anchor.text, "m c d");
        assert_eq!(out.grid.cells.len(), 3, "b and e keep column 2: {:?}", cell_texts(&out.grid));
    }

    #[test]
    fn split_cell_restores_slots_and_distributes_colwidth() {
        let html = "<table><tr><td colspan=\"2\" rowspan=\"2\" colwidth=\"100,120\"><p>m</p></td></tr>\
                    <tr></tr></table>";
        let out = edit(html, TableOp::SplitCell { at: (1, 1) });
        assert_eq!((out.grid.rows, out.grid.cols), (2, 2));
        assert_eq!(out.grid.cells.len(), 4);
        let anchor = out.grid.cells.iter().find(|c| (c.row, c.col) == (0, 0)).unwrap();
        assert_eq!((anchor.text.as_str(), anchor.colwidth.clone()), ("m", Some(vec![100])));
        let right = out.grid.cells.iter().find(|c| (c.row, c.col) == (0, 1)).unwrap();
        assert_eq!((right.text.as_str(), right.colwidth.clone()), ("", Some(vec![120])));
        assert!(!out.html.contains("colspan") && !out.html.contains("rowspan"), "{}", out.html);

        let plain = "<table><tr><td><p>a</p></td><td><p>b</p></td></tr></table>";
        assert!(edit_table_in_html(plain, &TableSel::Sole, &TableOp::SplitCell { at: (0, 0) })
            .unwrap_err()
            .starts_with("ERR_SPLIT_NOT_MERGED"));
    }

    #[test]
    fn set_cell_attrs_sets_clears_and_guards_scope() {
        let html = "<table><tr><th scope=\"col\"><p>h</p></th></tr><tr><td><p>a</p></td></tr></table>";
        let out = edit(
            html,
            TableOp::SetCellAttrs {
                at: (1, 0),
                background_color: Some("#eef".into()),
                align: Some("right".into()),
                scope: None,
            },
        );
        assert!(out.html.contains("background-color: #eef"), "{}", out.html);
        assert!(out.html.contains("text-align: right"), "{}", out.html);

        let cleared = edit(
            &out.html,
            TableOp::SetCellAttrs {
                at: (1, 0),
                background_color: Some(String::new()),
                align: Some(String::new()),
                scope: None,
            },
        );
        assert!(!cleared.html.contains("background-color"), "{}", cleared.html);

        let err = edit_table_in_html(
            html,
            &TableSel::Sole,
            &TableOp::SetCellAttrs {
                at: (1, 0),
                background_color: None,
                align: None,
                scope: Some("col".into()),
            },
        )
        .unwrap_err();
        assert!(err.starts_with("ERR_CELL_ATTR"), "{err}");
    }

    #[test]
    fn moves_reorder_and_refuse_merged_tables() {
        let plain = "<table><tr><td><p>a</p></td><td><p>b</p></td></tr>\
                     <tr><td><p>c</p></td><td><p>d</p></td></tr></table>";
        let out = edit(plain, TableOp::MoveRow { from: 0, to: 1 });
        assert_eq!(
            cell_texts(&out.grid),
            vec![
                (0, 0, "c".to_string()),
                (0, 1, "d".to_string()),
                (1, 0, "a".to_string()),
                (1, 1, "b".to_string())
            ]
        );
        let out = edit(plain, TableOp::MoveColumn { from: 1, to: 0 });
        assert_eq!(cell_texts(&out.grid)[0], (0, 0, "b".to_string()));

        assert!(edit_table_in_html(WIDE, &TableSel::Sole, &TableOp::MoveRow { from: 0, to: 1 })
            .unwrap_err()
            .starts_with("ERR_TABLE_HAS_MERGES"));
    }

    #[test]
    fn toggle_header_row_and_column_flip_roles() {
        let plain = "<table><tr><td><p>a</p></td><td><p>b</p></td></tr>\
                     <tr><td><p>c</p></td><td><p>d</p></td></tr></table>";
        let promoted = edit(plain, TableOp::ToggleHeaderRow);
        assert_eq!(promoted.grid.cells.iter().filter(|c| c.tag == "th").count(), 2);
        let demoted = edit(&promoted.html, TableOp::ToggleHeaderRow);
        assert_eq!(demoted.grid.cells.iter().filter(|c| c.tag == "th").count(), 0);

        let col = edit(plain, TableOp::ToggleHeaderColumn);
        let headers: Vec<_> =
            col.grid.cells.iter().filter(|c| c.tag == "th").map(|c| (c.row, c.col)).collect();
        assert_eq!(headers, vec![(0, 0), (1, 0)]);
    }

    #[test]
    fn toggle_header_row_demotion_drops_scope() {
        let html = "<table><tr><th scope=\"col\"><p>h</p></th></tr><tr><td><p>a</p></td></tr></table>";
        let out = edit(html, TableOp::ToggleHeaderRow);
        assert!(!out.html.contains("scope"), "demoted td must not carry scope: {}", out.html);
    }

    #[test]
    fn set_column_width_writes_through_spans_and_clears() {
        let out = edit(WIDE, TableOp::SetColumnWidth { col: 1, width: Some(150) });
        let w = out.grid.cells.iter().find(|c| c.text == "w").unwrap();
        assert_eq!(w.colwidth, Some(vec![0, 150]), "span cell records the width at its column position");
        let y = out.grid.cells.iter().find(|c| c.text == "y").unwrap();
        assert_eq!(y.colwidth, Some(vec![150]));

        let cleared = edit(&out.html, TableOp::SetColumnWidth { col: 1, width: None });
        assert!(!cleared.html.contains("colwidth"), "all-zero colwidth must drop: {}", cleared.html);
    }

    #[test]
    fn edit_reports_sanitize_fixes_on_mangled_input() {
        // A pre-D2-mangled ragged table heals on first touch, visibly.
        let ragged = "<table><tr><td><p>a</p></td></tr>\
                      <tr><td><p>b</p></td><td><p>c</p></td></tr></table>";
        let out = edit(ragged, TableOp::SetColumnWidth { col: 0, width: Some(80) });
        assert!(!out.fixes.is_empty(), "sanitize fixes must surface");
        assert_eq!((out.grid.rows, out.grid.cols), (2, 2));
    }

    #[test]
    fn nested_table_is_selectable_and_opaque_to_outer_ops() {
        let html = "<table><tr><td>\
                      <table><tr><td><p>inner</p></td></tr></table>\
                    </td><td><p>outer</p></td></tr></table>";
        let inner = table_grid_in_html(html, &TableSel::Index(1)).expect("inner by index");
        assert_eq!(inner.cells[0].text, "inner");
        // An outer AddColumn leaves the inner table untouched.
        let out = edit_table_in_html(html, &TableSel::Index(0), &TableOp::AddColumn { col: 1, side: Side::After })
            .expect("outer op");
        let inner_after = table_grid_in_html(&out.html, &TableSel::Index(1)).expect("inner");
        assert_eq!((inner_after.rows, inner_after.cols), (1, 1));
        assert_eq!(inner_after.cells[0].text, "inner");
    }

    #[test]
    fn out_of_range_coordinates_are_hard_errors() {
        let err = edit_table_in_html(WIDE, &TableSel::Sole, &TableOp::AddRow { row: 5, side: Side::Before })
            .unwrap_err();
        assert!(err.starts_with("ERR_CELL_RANGE"), "{err}");
        assert!(err.contains("2×2"), "error must carry the grid dims: {err}");
    }
}
