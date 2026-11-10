/**
 * Table layout and drawing for PDF export: column widths, the cell grid with
 * spans, and rows that break across pages.
 */

import type { JSONContent } from '@tiptap/core';
import { PDF_FONT_SANS } from './fonts';
import { checkPageBreak, type PDFRenderContext } from './context';
import { PDF_STYLE } from './style';
import { extractSegmentsDeep, extractText, parseColor, renderSegmentedText } from './text';

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
      ctx.doc.setFont(PDF_FONT_SANS, gc.isHeader ? 'bold' : 'normal');
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
 */
export async function renderTable(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
  const rows = node.content || [];
  if (rows.length === 0) return;

  const layout = computeTableLayout(ctx, node);
  if (layout.numCols === 0) return;

  const fontSize = PDF_STYLE.bodyFontSize - 1;

  // Check if entire table fits, otherwise start on new page
  checkPageBreak(ctx, Math.min(layout.totalHeight, layout.rowHeights[0]! + 10));

  // Track the Y position where each row starts (may shift on page breaks)
  const rowYPositions: number[] = [];

  for (let ri = 0; ri < rows.length; ri++) {
    const rowHeight = layout.rowHeights[ri]!;

    checkPageBreak(ctx, rowHeight);
    rowYPositions[ri] = ctx.y;

    // Draw cells in this row (only origin cells — skip spanned positions)
    for (let ci = 0; ci < layout.numCols; ci++) {
      const gc = layout.grid[ri]?.[ci];
      if (!gc || gc.originRow !== ri || gc.originCol !== ci) continue;

      // Compute cell position and dimensions
      let cellX = ctx.marginLeft;
      for (let c = 0; c < ci; c++) cellX += layout.colWidths[c]!;

      let cellWidth = 0;
      for (let dc = 0; dc < gc.colspan && ci + dc < layout.numCols; dc++) {
        cellWidth += layout.colWidths[ci + dc]!;
      }

      let cellHeight = 0;
      for (let dr = 0; dr < gc.rowspan && ri + dr < rows.length; dr++) {
        cellHeight += layout.rowHeights[ri + dr]!;
      }

      const cellTop = ctx.y - 3;

      // Cell background
      const bgColor = gc.node.attrs?.['backgroundColor'] as string | null | undefined;
      if (bgColor) {
        const rgb = parseColor(bgColor);
        if (rgb) {
          ctx.doc.setFillColor(rgb[0], rgb[1], rgb[2]);
          ctx.doc.rect(cellX, cellTop, cellWidth, cellHeight, 'F');
        }
      } else if (gc.isHeader) {
        ctx.doc.setFillColor(PDF_STYLE.tableHeaderBg);
        ctx.doc.rect(cellX, cellTop, cellWidth, cellHeight, 'F');
      }

      // Cell border
      ctx.doc.setDrawColor(PDF_STYLE.tableBorderColor);
      ctx.doc.setLineWidth(0.2);
      ctx.doc.rect(cellX, cellTop, cellWidth, cellHeight, 'S');

      // Cell text
      const textX = cellX + PDF_STYLE.tableCellPadding;
      const textY = ctx.y + PDF_STYLE.tableCellPadding - 1;
      const cellContentWidth = cellWidth - PDF_STYLE.tableCellPadding * 2;

      const segments = extractSegmentsDeep(gc.node);
      const plainText = segments.map((s) => s.text).join('');

      if (plainText.trim()) {
        const cellFontStyle = gc.isHeader ? 'bold' : 'normal';
        const savedY = ctx.y;
        ctx.y = textY;
        renderSegmentedText(ctx, segments, fontSize, cellFontStyle, textX, cellContentWidth, 'left');
        ctx.y = savedY;
      }
    }

    ctx.y += rowHeight;
  }

  // Reset
  ctx.doc.setFont(PDF_FONT_SANS, 'normal');
  ctx.doc.setFontSize(PDF_STYLE.bodyFontSize);
  ctx.doc.setTextColor(0, 0, 0);
  ctx.y += 4;
}
