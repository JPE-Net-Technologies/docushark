---
name: docushark-edit-tables
description: Use when the user wants to restructure a table in a DocuShark prose page over MCP — add/delete/reorder rows or columns, merge or split cells, toggle header rows/columns, set cell styling, or resize columns. Requires the DocuShark MCP server to be connected.
---

# Edit tables in DocuShark

Tables live inside prose pages and support merged cells (`colspan`/`rowspan`)
and per-column widths (`colwidth`). Two kinds of table work, two tools:

- **Cell TEXT** → `set_prose` with the cell's durable block `id` (every cell's
  first block has one; `get_table` returns it per cell). Never `edit_table`.
- **Table STRUCTURE** → `get_table` + `edit_table`, one operation per call.

## The coordinate model

Always `get_table(docId, pageId, …)` first. It returns the resolved,
**span-aware grid**: `rows`/`cols` plus one entry per cell with its 0-based
anchor slot (`row`, `col`), `colspan`/`rowspan`, `tag` (`th`/`td`), `text`,
`colwidth`, styling, and `id`. A merged cell covers a rectangle of slots and is
addressable through **any** slot it covers. Select the table with `tableIndex`
(0-based, document order), or an `anchor`/`id` of a line inside it; omit both
when the page has exactly one table.

Coordinates go stale the moment the table changes: every `edit_table` call
returns the post-op grid — chain from THAT, and re-read on `ERR_CELL_RANGE`
rather than guessing.

## Operations (one per call)

| Op | Args | Behavior |
| -- | -- | -- |
| `addRow` / `addColumn` | `row`/`col`, `side` (before/after, default after) | A merged cell spanning the insertion boundary GROWS through it instead of being split; new row cells adopt the column's existing width. |
| `deleteRow` / `deleteColumn` | `row`/`col` | Spans shrink; a rowspan remainder moves down. The last row/column is refused (`ERR_TABLE_LAST_*`). |
| `mergeCells` | `fromRow`,`fromCol`,`toRow`,`toCol` | Merges the rectangle; contents concatenate onto the top-left cell. A rectangle cutting through an existing merge is refused (`ERR_MERGE_PARTIAL_SPAN`) — merge or split that cell first. |
| `splitCell` | `row`,`col` | Back to 1×1 cells; content stays on the anchor. Refused on unmerged cells. |
| `setCellAttrs` | `row`,`col` + `backgroundColor`/`align`/`scope` | `""` clears an attr; `scope` is header-cells-only. |
| `moveRow` / `moveColumn` | `from`,`to` | Refused on tables with ANY merged cell (`ERR_TABLE_HAS_MERGES`) — split first. |
| `toggleHeaderRow` / `toggleHeaderColumn` | — | Flips row 0 / column 0 between `th` and `td`. |
| `setColumnWidth` | `col`, `width` (px) | Writes the width through every covering cell; omit `width` to clear. |

## Recipe

1. `get_prose` / `get_table` to find the table and read its grid.
2. Plan the sequence of single ops (e.g. add a column, then set its header
   text via `set_prose` on the new cell's `id`, then `setColumnWidth`).
3. Apply ops one at a time, chaining coordinates from each returned grid.
4. If the result carries a `fixes` array, the page's table was structurally
   healed while parsing (a legacy mangled merge) — re-read before continuing.

Writes replace the whole page (same granularity as `restructure_outline`), so
batch your STRUCTURAL changes tightly when a human is editing the same page.
