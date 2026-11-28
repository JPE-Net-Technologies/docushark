/**
 * Where the PDF's pages break, without writing a PDF (DSK-252).
 *
 * This runs the export's own layout on a `MeasureDoc`: the same renderers and
 * the same font metrics, with drawing switched off. So the breaks it returns
 * are the PDF's own, which is what Paper Mode (DSK-48) shows.
 */

import { jsPDF } from 'jspdf';
import type { RichTextContent } from '../../types/RichText';
import type { PDFExportOptions } from '../../types/PDFExport';
import type { PDFCanvasPage, PDFRichTextPage } from './context';
import { MeasureDoc } from './doc';
import { pdfFontFor, registerPDFFonts } from './fonts';
import { layOut, layoutOf, type PdfLayout } from './layout';

export type { PdfLayout } from './layout';
export type { BreakAt, InlinePosition, PageBreak } from './pager';

interface Metrics {
  pdf: jsPDF;
  textFont: string;
}

/**
 * One measuring jsPDF per document font. Registering the fonts is most of a
 * layout's fixed cost, so it happens once per font, not once per layout.
 */
const metricsByFont = new Map<string, Promise<Metrics>>();

function metricsFor(fontFamily: string | undefined): Promise<Metrics> {
  const font = pdfFontFor(fontFamily);
  let metrics = metricsByFont.get(font.id);
  if (!metrics) {
    const pdf = new jsPDF({ unit: 'mm', compress: true });
    metrics = registerPDFFonts(pdf, font).then((textFont) => ({ pdf, textFont }));
    // A failed font load must not stick: the next layout tries again.
    metrics.catch(() => metricsByFont.delete(font.id));
    metricsByFont.set(font.id, metrics);
  }
  return metrics;
}

/**
 * Layouts run one after another: a measuring jsPDF holds the current font and
 * size, and an image load inside one layout would otherwise let another change
 * them between a font change and a measurement.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Lay the document out as `exportToPdf` would, with the same arguments, and
 * return where its pages break. Nothing is drawn and no PDF is written.
 */
export function paginate(
  options: PDFExportOptions,
  richTextContent: RichTextContent,
  themeBackground?: string,
  richTextPages?: PDFRichTextPage[],
  canvasPages?: PDFCanvasPage[]
): Promise<PdfLayout> {
  const run = async (): Promise<PdfLayout> => {
    const { pdf, textFont } = await metricsFor(options.fontFamily);
    const ctx = await layOut(new MeasureDoc(pdf), textFont, {
      options,
      richTextContent,
      themeBackground,
      richTextPages,
      canvasPages,
    });
    return layoutOf(options, ctx);
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
