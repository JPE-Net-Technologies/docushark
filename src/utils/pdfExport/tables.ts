/**
 * Table layout and drawing for PDF export: column widths, the cell grid with
 * spans, and rows that break across pages.
 */

import type { JSONContent } from '@tiptap/core';
import { checkPageBreak, newPage, pageContentHeight, spaceLeft, type PDFRenderContext } from './context';
import type { BreakAt } from './pager';
import { PDF_STYLE } from './style';
import {
  drawLines,
  extractSegmentsDeep,
  extractText,
  layoutLines,
  lineHeightOf,
  parseColor,
  renderSegmentedText,
  type TextLine,
} from './text';

/**
 * Table layout including per-column widths, per-row heights, and a grid model
 * that tracks which cells are occupied by colspan/rowspan merges.
 */
interface TableLayout {
  /** Number of logical columns */
  numCols: number;
  /** Width of each logical column (mm) */
  colWidths: number[];
  /** Height of each row (mm) */
  rowHeights: number[];
  totalWidth: number;
  totalHeight: number;
  /**
   * Grid model: `grid[row][col]` holds the cell that occupies that position.
   * A merged cell (colspan > 1 or rowspan > 1) writes itself into every
   * grid position it spans. Renderers draw only the "origin" position
   * (where row === originRow && col === originCol).
   */
  grid: TableGridCell[][];
}

interface TableGridCell {
  /** The Tiptap JSON node for this cell */
  node: JSONContent;
  /** Grid row of the cell's top-left corner */
  originRow: number;
  /** Grid column of the cell's top-left corner */
  originCol: number;
  /** How many columns this cell spans */
  colspan: number;
  /** How many rows this cell spans */
  rowspan: number;
  /** Whether this is a header cell */
  isHeader: boolean;
}

/**
 * Distribute the PDF content width across table columns (JP-432 Pillar D).
 * `declared` holds each column's editor colwidth in px (`null` = unsized).
 * With no sizes, columns share equally. With any, declared px become
 * proportional weights — unsized columns weigh in at the declared average —
 * and everything scales to fill `totalWidth` exactly (a PDF table always
 * spans the content width; only the RATIOS survive the medium change).
 */
export function distributeColumnWidths(
  declared: (number | null)[],
  totalWidth: number
): number[] {
  const numCols = declared.length;
  if (numCols === 0) return [];
  const declaredVals = declared.filter((w): w is number => w != null && w > 0);
  if (declaredVals.length === 0) {
    return Array(numCols).fill(totalWidth / numCols) as number[];
  }
  const avg = declaredVals.reduce((a, b) => a + b, 0) / declaredVals.length;
  const weights = declared.map((w) => (w != null && w > 0 ? w : avg));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (w / sum) * totalWidth);
}

/**
 * Compute table layout with colspan/rowspan support.
 *
 * 1. Determine the logical column count by scanning all rows.
 * 2. Build a grid model that tracks which cell occupies each (row, col) position.
 * 3. Compute column widths (from colwidth attrs when present, else equal).
 * 4. Compute row heights by measuring text in each cell's actual spanned width.
 */
function computeTableLayout(ctx: PDFRenderContext, node: JSONContent): TableLayout {
  const rows = node.content || [];
  if (rows.length === 0) {
    return { numCols: 0, colWidths: [], rowHeights: [], totalWidth: 0, totalHeight: 0, grid: [] };
  }

  // First pass: determine logical column count.
  // The logical column count is the sum of colspans in the first row,
  // accounting for cells that rowspan into this row from above.
  // A simpler heuristic: scan all rows and take the max logical width.
  let numCols = 0;
  for (const row of rows) {
    let rowLogicalCols = 0;
    if (row.content) {
      for (const cell of row.content) {
        const cs = (cell.attrs?.['colspan'] as number | undefined) || 1;
        rowLogicalCols += cs;
      }
    }
    numCols = Math.max(numCols, rowLogicalCols);
  }
  if (numCols === 0) {
    return { numCols: 0, colWidths: [], rowHeights: [], totalWidth: 0, totalHeight: 0, grid: [] };
  }

  // Build the grid model
  const numRows = rows.length;
  const grid: (TableGridCell | null)[][] = Array.from({ length: numRows }, () =>
    Array(numCols).fill(null) as (TableGridCell | null)[]
  );

  for (let ri = 0; ri < numRows; ri++) {
    const cells = rows[ri]!.content || [];
    let ci = 0; // logical column pointer
    for (const cell of cells) {
      // Advance past positions already occupied by a rowspan from a previous row
      while (ci < numCols && grid[ri]![ci] !== null) ci++;
      if (ci >= numCols) break;

      const colspan = (cell.attrs?.['colspan'] as number | undefined) || 1;
      const rowspan = (cell.attrs?.['rowspan'] as number | undefined) || 1;
      const isHeader = cell.type === 'tableHeader';

      const gridCell: TableGridCell = {
        node: cell,
        originRow: ri,
        originCol: ci,
        colspan,
        rowspan,
        isHeader,
      };

      // Fill every grid position this cell occupies
      for (let dr = 0; dr < rowspan && ri + dr < numRows; dr++) {
        for (let dc = 0; dc < colspan && ci + dc < numCols; dc++) {
          grid[ri + dr]![ci + dc] = gridCell;
        }
      }

      ci += colspan;
    }
  }

  // Compute column widths: honor the editor's per-column colwidth attrs
  // (px, from column-resize drags — one entry per spanned column) when any
  // exist, scaled to the PDF content width; equal distribution otherwise.
  const declared: (number | null)[] = Array(numCols).fill(null) as (number | null)[];
  for (let ri = 0; ri < numRows; ri++) {
    for (let ci = 0; ci < numCols; ci++) {
      const gc = grid[ri]![ci];
      if (!gc || gc.originRow !== ri || gc.originCol !== ci) continue;
      const cw = gc.node.attrs?.['colwidth'] as unknown;
      if (!Array.isArray(cw)) continue;
      for (let dc = 0; dc < gc.colspan && ci + dc < numCols; dc++) {
        const w = cw[dc] as unknown;
        if (typeof w === 'number' && w > 0 && declared[ci + dc] == null) {
          declared[ci + dc] = w;
        }
      }
    }
  }
  const totalWidth = ctx.contentWidth;
  const colWidths = distributeColumnWidths(declared, totalWidth);

  // Compute row heights by measuring cell content
  const fontSize = PDF_STYLE.bodyFontSize - 1;
  const lineH = fontSize * 0.352778 * PDF_STYLE.lineHeight;
  const rowHeights: number[] = Array(numRows).fill(lineH + PDF_STYLE.tableCellPadding * 2) as number[];

  for (let ri = 0; ri < numRows; ri++) {
    for (let ci = 0; ci < numCols; ci++) {
      const gc = grid[ri]![ci];
      if (!gc || gc.originRow !== ri || gc.originCol !== ci) continue; // skip spanned positions

      // Cell content width = sum of spanned columns minus padding
      let cellTotalWidth = 0;
      for (let dc = 0; dc < gc.colspan && ci + dc < numCols; dc++) {
        cellTotalWidth += colWidths[ci + dc]!;
      }
      const cellContentWidth = cellTotalWidth - PDF_STYLE.tableCellPadding * 2;

      const text = extractText(gc.node);
      ctx.doc.setFontSize(fontSize);
      ctx.doc.setFont(ctx.textFont, gc.isHeader ? 'bold' : 'normal');
      const wrappedLines = ctx.doc.splitTextToSize(text, Math.max(cellContentWidth, 5));
      const neededHeight = wrappedLines.length * lineH + PDF_STYLE.tableCellPadding * 2;

      if (gc.rowspan === 1) {
        // Single-row cell: just take the max
        rowHeights[ri] = Math.max(rowHeights[ri]!, neededHeight);
      } else {
        // Multi-row cell: distribute height evenly across spanned rows,
        // but only if existing rows don't already provide enough space
        const existingHeight = rowHeights.slice(ri, ri + gc.rowspan).reduce((a, b) => a + b, 0);
        if (neededHeight > existingHeight) {
          const extra = (neededHeight - existingHeight) / gc.rowspan;
          for (let dr = 0; dr < gc.rowspan && ri + dr < numRows; dr++) {
            rowHeights[ri + dr] = rowHeights[ri + dr]! + extra;
          }
        }
      }
    }
  }

  const totalHeight = rowHeights.reduce((s, h) => s + h, 0);

  // Cast grid to non-null (unfilled positions default to null but shouldn't be rendered)
  return {
    numCols,
    colWidths,
    rowHeights,
    totalWidth,
    totalHeight,
    grid: grid as TableGridCell[][],
  };
}

/**
 * Render a table node to PDF with borders, headers, cell backgrounds,
 * and colspan/rowspan merged cell support.
 *
 * Page breaks (DSK-252):
 * - the header rows (the leading rows made only of header cells) are drawn
 *   again at the top of every page the table continues on;
 * - the header starts on the same page as the first body row;
 * - the rows a merged cell spans move together, when they fit on a page;
 * - a row taller than a page splits by lines, its borders drawn per page.
 */
export async function renderTable(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
  const rows = node.content || [];
  if (rows.length === 0) return;

  const layout = computeTableLayout(ctx, node);
  if (layout.numCols === 0) return;

  const fontSize = PDF_STYLE.bodyFontSize - 1;
  const tablePath = [...ctx.path];
  const headerRows = countHeaderRows(layout);
  const headerHeight = sumRows(layout, 0, headerRows);
  const rowAt = (row: number): BreakAt => ({
    kind: 'row',
    path: tablePath,
    row,
    ...(headerRows > 0 && row >= headerRows ? { header: headerRows } : {}),
  });

  // Start where the first rows fit: the first row and 10 mm, as before, and
  // the header with the first body row (or its merged group).
  const firstBody = headerRows > 0 ? headerHeight + sumRows(layout, headerRows, groupEnd(layout, headerRows)) : 0;
  const startRoom = Math.min(layout.totalHeight, Math.max(layout.rowHeights[0]! + 10, firstBody));
  checkPageBreak(ctx, startRoom <= pageContentHeight(ctx) ? startRoom : layout.rowHeights[0]! + 10);

  /** Start a new page in the table, and draw the header again at its top. */
  const continueOnNewPage = (at: BreakAt, row: number): void => {
    newPage(ctx, at);
    if (headerRows > 0 && row >= headerRows) {
      for (let hr = 0; hr < headerRows; hr++) {
        drawRow(ctx, layout, rows, hr, fontSize, rowAt(hr));
        ctx.y += layout.rowHeights[hr]!;
      }
    }
  };

  let ri = 0;
  while (ri < rows.length) {
    const repeats = headerRows > 0 && ri >= headerRows;
    const room = pageContentHeight(ctx) - (repeats ? headerHeight : 0);
    const end = groupEnd(layout, ri);
    const groupHeight = sumRows(layout, ri, end);
    const rowHeight = layout.rowHeights[ri]!;

    if (end - ri > 1 && groupHeight <= room) {
      // Rows a merged cell spans: kept together.
      if (groupHeight > spaceLeft(ctx)) continueOnNewPage(rowAt(ri), ri);
      for (let r = ri; r < end; r++) {
        drawRow(ctx, layout, rows, r, fontSize, rowAt(r));
        ctx.y += layout.rowHeights[r]!;
      }
      ri = end;
      continue;
    }

    if (rowHeight > room && end - ri === 1) {
      // Taller than a page: split by lines.
      if (spaceLeft(ctx) < minimumRowPiece(fontSize)) continueOnNewPage(rowAt(ri), ri);
      drawSplitRow(ctx, layout, rows, ri, fontSize, rowAt(ri), () => continueOnNewPage(rowAt(ri), ri));
      ri++;
      continue;
    }

    if (rowHeight > spaceLeft(ctx)) continueOnNewPage(rowAt(ri), ri);
    drawRow(ctx, layout, rows, ri, fontSize, rowAt(ri));
    ctx.y += rowHeight;
    ri++;
  }

  // Reset
  ctx.doc.setFont(ctx.textFont, 'normal');
  ctx.doc.setFontSize(PDF_STYLE.bodyFontSize);
  ctx.doc.setTextColor(0, 0, 0);
  ctx.y += 4;
}

/**
 * The leading rows made only of header cells, repeated on each page. None
 * when every row is a header row: there would be nothing to repeat them over.
 */
function countHeaderRows(layout: TableLayout): number {
  let count = 0;
  for (const row of layout.grid) {
    if (!row || row.length === 0 || !row.every((cell) => cell?.isHeader)) break;
    count++;
  }
  if (count === 0 || count >= layout.grid.length) return 0;
  // A merged header cell reaching into the body can't be repeated on its own.
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < layout.numCols; c++) {
      const cell = layout.grid[r]?.[c];
      if (cell && cell.originRow === r && cell.originCol === c && r + cell.rowspan > count) return 0;
    }
  }
  return count;
}

/** The row after the group of rows that merged cells starting at `start` span. */
function groupEnd(layout: TableLayout, start: number): number {
  let end = start + 1;
  for (let r = start; r < end && r < layout.grid.length; r++) {
    for (let c = 0; c < layout.numCols; c++) {
      const cell = layout.grid[r]?.[c];
      if (cell && cell.originRow === r && cell.originCol === c) end = Math.max(end, r + cell.rowspan);
    }
  }
  return Math.min(end, layout.grid.length);
}

/** Total height of rows `from` (inclusive) to `to` (exclusive). */
function sumRows(layout: TableLayout, from: number, to: number): number {
  let sum = 0;
  for (let r = from; r < to; r++) sum += layout.rowHeights[r] ?? 0;
  return sum;
}

/** The least room worth starting a split row in: one line and its padding. */
function minimumRowPiece(fontSize: number): number {
  return lineHeightOf(fontSize) + PDF_STYLE.tableCellPadding * 2;
}

/** A cell's x, width and height on the page (its spans included). */
function cellBox(ctx: PDFRenderContext, layout: TableLayout, rowCount: number, ri: number, ci: number, cell: TableGridCell): { x: number; width: number; height: number } {
  let x = ctx.marginLeft;
  for (let c = 0; c < ci; c++) x += layout.colWidths[c]!;
  let width = 0;
  for (let dc = 0; dc < cell.colspan && ci + dc < layout.numCols; dc++) width += layout.colWidths[ci + dc]!;
  let height = 0;
  for (let dr = 0; dr < cell.rowspan && ri + dr < rowCount; dr++) height += layout.rowHeights[ri + dr]!;
  return { x, width, height };
}

/** A cell's background and border, `height` tall, from the row's top at `ctx.y`. */
function drawCellFrame(ctx: PDFRenderContext, cell: TableGridCell, x: number, width: number, height: number): void {
  const cellTop = ctx.y - 3;

  // Cell background
  const bgColor = cell.node.attrs?.['backgroundColor'] as string | null | undefined;
  if (bgColor) {
    const rgb = parseColor(bgColor);
    if (rgb) {
      ctx.doc.setFillColor(rgb[0], rgb[1], rgb[2]);
      ctx.doc.rect(x, cellTop, width, height, 'F');
    }
  } else if (cell.isHeader) {
    ctx.doc.setFillColor(PDF_STYLE.tableHeaderBg);
    ctx.doc.rect(x, cellTop, width, height, 'F');
  }

  // Cell border
  ctx.doc.setDrawColor(PDF_STYLE.tableBorderColor);
  ctx.doc.setLineWidth(0.2);
  ctx.doc.rect(x, cellTop, width, height, 'S');
}

/** Draw row `ri`'s cells (only origin cells; spanned positions are skipped) at `ctx.y`. */
function drawRow(
  ctx: PDFRenderContext,
  layout: TableLayout,
  rows: JSONContent[],
  ri: number,
  fontSize: number,
  at: BreakAt
): void {
  for (let ci = 0; ci < layout.numCols; ci++) {
    const gc = layout.grid[ri]?.[ci];
    if (!gc || gc.originRow !== ri || gc.originCol !== ci) continue;

    const { x, width, height } = cellBox(ctx, layout, rows.length, ri, ci, gc);
    drawCellFrame(ctx, gc, x, width, height);

    // Cell text
    const textX = x + PDF_STYLE.tableCellPadding;
    const textY = ctx.y + PDF_STYLE.tableCellPadding - 1;
    const cellContentWidth = width - PDF_STYLE.tableCellPadding * 2;

    const segments = extractSegmentsDeep(gc.node);
    const plainText = segments.map((s) => s.text).join('');

    if (plainText.trim()) {
      const cellFontStyle = gc.isHeader ? 'bold' : 'normal';
      const savedY = ctx.y;
      ctx.y = textY;
      renderSegmentedText(ctx, segments, fontSize, cellFontStyle, textX, cellContentWidth, 'left', () => at);
      ctx.y = savedY;
    }
  }
}

/**
 * Draw a row taller than a page in pieces: on each page, as many of its lines
 * as fit, in every cell, with the cells' borders around that piece.
 */
function drawSplitRow(
  ctx: PDFRenderContext,
  layout: TableLayout,
  rows: JSONContent[],
  ri: number,
  fontSize: number,
  at: BreakAt,
  nextPage: () => void
): void {
  const lineH = lineHeightOf(fontSize);
  const pad = PDF_STYLE.tableCellPadding;
  const cells: Array<{ cell: TableGridCell; x: number; width: number; lines: TextLine[]; style: string }> = [];
  for (let ci = 0; ci < layout.numCols; ci++) {
    const gc = layout.grid[ri]?.[ci];
    if (!gc || gc.originRow !== ri || gc.originCol !== ci) continue;
    const { x, width } = cellBox(ctx, layout, rows.length, ri, ci, gc);
    const style = gc.isHeader ? 'bold' : 'normal';
    const segments = extractSegmentsDeep(gc.node);
    const hasText = segments.map((s) => s.text).join('').trim().length > 0;
    const lines = hasText ? layoutLines(ctx, segments, fontSize, style, width - pad * 2) : [];
    cells.push({ cell: gc, x, width, lines, style });
  }
  const total = Math.max(1, ...cells.map((c) => c.lines.length));

  let from = 0;
  while (from < total) {
    const fits = Math.max(1, Math.floor((spaceLeft(ctx) - pad * 2) / lineH));
    const to = Math.min(total, from + fits);
    const pieceHeight = (to - from) * lineH + pad * 2;
    for (const { cell, x, width, lines, style } of cells) {
      drawCellFrame(ctx, cell, x, width, pieceHeight);
      if (from < lines.length) {
        const savedY = ctx.y;
        ctx.y = ctx.y + pad - 1;
        drawLines(ctx, lines, fontSize, style, x + pad, width - pad * 2, 'left', () => at, from, Math.min(to, lines.length));
        ctx.y = savedY;
      }
    }
    ctx.y += pieceHeight;
    from = to;
    if (from < total) nextPage();
  }
}
