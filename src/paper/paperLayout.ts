/**
 * Paper Mode's layout (DSK-48): the options it lays out with, which of the
 * layout's breaks fall in the prose page being edited and the footers of their
 * pages, and (`fitPages`) the sheets on screen.
 *
 * All but `fitPages` are pure functions over the paginator's layout.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import type { PageEnd, PaperPages } from '../tiptap/PaperModeExtension';
import { getPageDimensions, type PDFExportOptions } from '../types/PDFExport';
import type { PdfLayout } from '../utils/pdfExport/paginate';
import { PDF_STYLE } from '../utils/pdfExport/style';
import { positionOfBreak } from './breakPositions';
import type { PageSetup } from './pageSetup';

/**
 * The export's options as Paper Mode lays out with them: the document's page
 * setup, and no embedded diagrams (they aren't laid out in the view; see the
 * guide).
 */
export function paperOptions(exportOptions: PDFExportOptions, setup: PageSetup): PDFExportOptions {
  return {
    ...exportOptions,
    pageSize: setup.size,
    orientation: setup.orientation,
    margins: { ...setup.margins },
    ...(exportOptions.diagramEmbed ? { diagramEmbed: { ...exportOptions.diagramEmbed, enabled: false } } : {}),
  };
}

/** The first top-level block that differs between two versions of a page (unchanged nodes are shared). */
export function firstChangedBlock(previous: PMNode, next: PMNode): number {
  const count = Math.min(previous.childCount, next.childCount);
  for (let i = 0; i < count; i++) {
    if (previous.child(i) !== next.child(i)) return i;
  }
  return count;
}

/** The number the PDF prints on content page `page` (1-based, counting the cover). */
export function printedPageNumber(page: number, layout: PdfLayout, options: PDFExportOptions): number {
  // The contents pages go in after the cover, or at the very front.
  return options.coverPage.enabled && page === 1 ? 1 : page + layout.contentsPages;
}

/** The footer the PDF prints on a page, or '' when it prints none. */
export function footerText(printed: number, total: number, options: PDFExportOptions): string {
  if (!options.showPageNumbers) return '';
  return options.pageNumberFormat === 'x-of-y' ? `Page ${printed} of ${total}` : `${printed}`;
}

/** The content pages prose page `index` occupies, first and last. */
export function prosePageSpan(layout: PdfLayout, index: number, options: PDFExportOptions): { first: number; last: number } {
  const startOf = (i: number): number | undefined =>
    layout.breaks.find((b) => b.at.kind === 'section' && b.at.section === 'prose' && b.at.index === i)?.page;
  const first = index === 0 ? (options.coverPage.enabled ? 2 : 1) : startOf(index) ?? layout.pages;
  const next = startOf(index + 1);
  return { first, last: next !== undefined ? next - 1 : layout.pages };
}

/**
 * The page ends to show in prose page `pageId` (its `doc` in the editor), each
 * with the footer of the page it ends, and the footer of its last page.
 */
export function paperPagesFor(
  layout: PdfLayout,
  pageId: string | undefined,
  proseIndex: number,
  doc: PMNode,
  options: PDFExportOptions
): PaperPages {
  const total = layout.pages + layout.contentsPages;
  const footerOf = (page: number) => footerText(printedPageNumber(page, layout, options), total, options);
  const ends: PageEnd[] = [];
  for (const b of layout.breaks) {
    if (b.pageId !== pageId || b.at.kind === 'section') continue;
    const at = positionOfBreak(doc, b.at);
    if (at) ends.push({ at, footer: footerOf(b.page - 1) });
  }
  return { ends, lastFooter: footerOf(prosePageSpan(layout, proseIndex, options).last) };
}

/** CSS px per mm (96 per inch). */
const PX_PER_MM = 96 / 25.4;

/** The gap between two sheets on screen, in CSS px (`--paper-band`). */
export const PAPER_BAND_PX = 24;

/** A page's parts on screen, in CSS px. */
export interface PaperGeometry {
  /** The height a page gives its content. */
  content: number;
  /** Below the content: the footer's space and the bottom margin (`--paper-foot`). */
  foot: number;
  /** Between two sheets. */
  band: number;
  /** Above the content: the top margin. */
  head: number;
  /** The bottom margin, where the footer sits half way down. */
  marginBottom: number;
}

export function paperGeometry(options: PDFExportOptions): PaperGeometry {
  const { height } = getPageDimensions(options.pageSize, options.orientation);
  const footer = options.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
  const { top, bottom } = options.margins;
  return {
    content: (height - top - bottom - footer) * PX_PER_MM,
    foot: (bottom + footer) * PX_PER_MM,
    band: PAPER_BAND_PX,
    head: top * PX_PER_MM,
    marginBottom: bottom * PX_PER_MM,
  };
}

/** The page's size and margins as CSS custom properties, for the sheet and its gaps. */
export function paperCssVariables(options: PDFExportOptions): Record<string, string> {
  const { width, height } = getPageDimensions(options.pageSize, options.orientation);
  const footer = options.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
  return {
    '--paper-width': `${width}mm`,
    '--paper-height': `${height}mm`,
    '--paper-margin-top': `${options.margins.top}mm`,
    '--paper-margin-right': `${options.margins.right}mm`,
    '--paper-margin-bottom': `${options.margins.bottom}mm`,
    '--paper-margin-left': `${options.margins.left}mm`,
    '--paper-footer-space': `${footer}mm`,
    '--paper-band': `${PAPER_BAND_PX}px`,
  };
}

/** A sheet's gap below it and its footer, in the sheet column's coordinates. */
interface SheetEnd {
  /** Where the sheet ends. */
  bottom: number;
  footer: string;
  /** Whether a gap to the next sheet follows. */
  gap: boolean;
}

/**
 * Make every page exactly one page tall on screen, and draw the gaps between
 * the sheets and their footers over the text.
 *
 * `root` is the editor (its parent the sheet column, which holds the page
 * variables); each page end in it (a `.paper-gap` widget or a
 * `tr.paper-row-break`) gets the room its page has left as
 * `--paper-space-<index>` on the column. A page's content height doesn't depend
 * on that room, so one measuring pass finds every page's: the room only moves
 * what follows. The variables are written only when they change, so typing
 * that doesn't change a page's lines costs no second layout.
 */
export function fitPages(root: HTMLElement, overlay: HTMLElement, geometry: PaperGeometry): void {
  const column = root.parentElement;
  if (!column) return;
  const origin = column.getBoundingClientRect().top;
  const style = getComputedStyle(root);
  // Where page 1's content starts, then each next page's, as laid out now.
  let start = root.getBoundingClientRect().top - origin + (parseFloat(style.paddingTop) || 0);
  // How far what follows moves once the new room is set.
  let shift = 0;
  const ends: SheetEnd[] = [];
  const writes: Array<[string, number]> = [];

  for (const end of root.querySelectorAll<HTMLElement>('.paper-gap, tr.paper-row-break')) {
    if (end.getClientRects().length === 0) continue;
    const index = end.dataset['paperIndex'];
    if (index === undefined) continue;
    const variable = `--paper-space-${index}`;
    const current = parseFloat(column.style.getPropertyValue(variable)) || 0;
    const top = end.getBoundingClientRect().top - origin;
    const used = top - start;
    const room = Math.max(0, geometry.content - used);
    if (Math.abs(room - current) > 0.01) writes.push([variable, room]);
    const contentEnd = start + shift + Math.max(geometry.content, used);
    const last = index === 'last';
    ends.push({ bottom: contentEnd + geometry.foot, footer: end.dataset['paperFoot'] ?? '', gap: !last });
    // The next page starts below this end's room, margins and gap.
    start = top + current + geometry.foot + geometry.band + geometry.head;
    shift += room - current;
    if (last) break;
  }

  for (const [variable, room] of writes) column.style.setProperty(variable, `${room}px`);
  drawSheetEnds(overlay, ends, geometry);
}

/** The gaps and footers, reusing the overlay's elements. */
function drawSheetEnds(overlay: HTMLElement, ends: SheetEnd[], geometry: PaperGeometry): void {
  const bands = ends.filter((end) => end.gap).length;
  const want = bands + ends.length;
  while (overlay.childElementCount > want) overlay.lastElementChild!.remove();
  while (overlay.childElementCount < want) overlay.append(document.createElement('div'));
  let child = overlay.firstElementChild as HTMLElement | null;
  for (const end of ends) {
    const footer = child!;
    footer.className = 'paper-footer';
    // The PDF puts the footer's baseline half way down the bottom margin.
    footer.style.top = `${end.bottom - geometry.marginBottom / 2}px`;
    if (footer.textContent !== end.footer) footer.textContent = end.footer;
    child = footer.nextElementSibling as HTMLElement | null;
    if (!end.gap) continue;
    const band = child!;
    band.className = 'paper-band';
    band.style.top = `${end.bottom}px`;
    child = band.nextElementSibling as HTMLElement | null;
  }
}
