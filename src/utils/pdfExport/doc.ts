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

import type { ImageOptions, jsPDF, TextOptionsLight } from 'jspdf';

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

/**
 * Measures with a real jsPDF (fonts registered) and draws nothing. It counts
 * pages so that page-dependent bookkeeping in the renderers still adds up.
 */
export class MeasureDoc implements PdfDoc {
  private pageCount = 1;

  constructor(private readonly metrics: jsPDF) {}

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
    return this.metrics.splitTextToSize(text, maxLength) as string[];
  }

  addPage(): void {
    this.pageCount++;
  }

  setPage(): void {}

  getNumberOfPages(): number {
    return this.pageCount;
  }

  setTextColor(): void {}
  setFillColor(): void {}
  setDrawColor(): void {}
  setLineWidth(): void {}
  text(): void {}
  rect(): void {}
  line(): void {}
  circle(): void {}
  addImage(): void {}
  link(): void {}
}
