/**
 * The document the layout draws on (DSK-252).
 *
 * `PdfDoc` is the part of jsPDF that the layout and the node renderers use. A
 * real jsPDF is one, and draws. A `MeasureDoc` is another: it measures text
 * with a real jsPDF's metrics and draws nothing, so the same layout code can
 * say where the pages break without writing a PDF. Because the renderers see
 * only this interface, they can't reach anything a `MeasureDoc` lacks.
 *
 * The contents pages, the outline and the page numbers aren't layout: they are
 * added to a finished export, through the real jsPDF (`furniture.ts`).
 */

import type { ImageOptions, TextOptionsLight } from 'jspdf';

export interface PdfDoc {
  // Metrics. They depend on the font and size set before them.
  setFont(fontName: string, fontStyle?: string): unknown;
  setFontSize(size: number): unknown;
  getTextWidth(text: string): number;
  splitTextToSize(text: string, maxLength: number): string[];

  // Pages.
  addPage(): unknown;
  setPage(pageNumber: number): unknown;
  getNumberOfPages(): number;

  // Drawing.
  setTextColor(ch1: string | number, ch2?: number, ch3?: number): unknown;
  setFillColor(ch1: string | number, ch2?: number, ch3?: number): unknown;
  setDrawColor(ch1: string | number, ch2?: number, ch3?: number): unknown;
  setLineWidth(width: number): unknown;
  text(text: string | string[], x: number, y: number, options?: TextOptionsLight): unknown;
  rect(x: number, y: number, w: number, h: number, style?: string | null): unknown;
  line(x1: number, y1: number, x2: number, y2: number, style?: string | null): unknown;
  circle(x: number, y: number, r: number, style?: string | null): unknown;
  addImage(options: ImageOptions): unknown;
  link(x: number, y: number, w: number, h: number, options: { url: string } | { pageNumber: number }): unknown;
}

/** Where a `MeasureDoc` gets its metrics: a real jsPDF with the fonts registered. */
export type PdfMetrics = Pick<PdfDoc, 'setFont' | 'setFontSize' | 'getTextWidth' | 'splitTextToSize'>;

/**
 * Measures with a real jsPDF (fonts registered) and draws nothing. It counts
 * pages so that page-dependent bookkeeping in the renderers still adds up.
 */
export class MeasureDoc implements PdfDoc {
  private pageCount = 1;

  constructor(private readonly metrics: PdfMetrics) {}

  setFont(fontName: string, fontStyle?: string): void {
    this.metrics.setFont(fontName, fontStyle);
  }

  setFontSize(size: number): void {
    this.metrics.setFontSize(size);
  }

  getTextWidth(text: string): number {
    return this.metrics.getTextWidth(text);
  }

  splitTextToSize(text: string, maxLength: number): string[] {
    return this.metrics.splitTextToSize(text, maxLength);
  }

  addPage(): void {
    this.pageCount++;
  }

  setPage(_pageNumber: number): void {}

  getNumberOfPages(): number {
    return this.pageCount;
  }

  setTextColor(_ch1: string | number, _ch2?: number, _ch3?: number): void {}
  setFillColor(_ch1: string | number, _ch2?: number, _ch3?: number): void {}
  setDrawColor(_ch1: string | number, _ch2?: number, _ch3?: number): void {}
  setLineWidth(_width: number): void {}
  text(_text: string | string[], _x: number, _y: number, _options?: TextOptionsLight): void {}
  rect(_x: number, _y: number, _w: number, _h: number, _style?: string | null): void {}
  line(_x1: number, _y1: number, _x2: number, _y2: number, _style?: string | null): void {}
  circle(_x: number, _y: number, _r: number, _style?: string | null): void {}
  addImage(_options: ImageOptions): void {}
  link(_x: number, _y: number, _w: number, _h: number, _options: { url: string } | { pageNumber: number }): void {}
}
