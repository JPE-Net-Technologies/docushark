/**
 * Paper Mode's layout driver (DSK-48): lays the document out as the PDF
 * export would and shows the PDF's page breaks in the editor.
 *
 * - On: the whole document is laid out (`paginate`).
 * - After an edit, once typing pauses: laid out again from the first top-level
 *   block that changed (`relayoutFrom`), which gives what `paginate` would.
 *   A layout that finishes after another edit is dropped and run again.
 * - Each layout's breaks go to `PaperModeExtension` as decorations, and
 *   `fitPages` makes every page one page tall on screen. It runs again in the
 *   next frame after any edit or size change, so the sheets keep up with the
 *   text between layouts.
 *
 * The paginator (and jsPDF with it) loads only when Paper Mode is first on.
 */

import { useEffect, useMemo } from 'react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { useDocumentFont } from '../fonts/documentFont';
import { onFontLoad } from '../fonts/fontLoader';
import { createInitialPDFOptions } from '../store/pdfExportStore';
import { loadDocumentPdfSettings, usePersistenceStore } from '../store/persistenceStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { useRichTextStore } from '../store/richTextStore';
import { setPaperPages } from '../tiptap/PaperModeExtension';
import type { PDFExportOptions } from '../types/PDFExport';
import type { PdfLayout } from '../utils/pdfExport/paginate';
import type { PDFRichTextPage } from '../utils/pdfExportUtils';
import { collectPdfPages, type PageJsonCache } from './collectPdfPages';
import { resolvePageSetup, usePageSetting } from './pageSetup';
import { firstChangedBlock, fitPages, paperGeometry, paperOptions, paperPagesFor } from './paperLayout';

/** How long typing pauses before the pages are laid out again. */
export const PAPER_LAYOUT_DELAY_MS = 300;

/** The options Paper Mode lays out with: the export's, as the dialog would start them. */
export function usePaperOptions(): PDFExportOptions {
  // The page setting changes on every export too, which is when the other
  // export settings can have changed: they're read again with it.
  const stored = usePageSetting();
  const documentId = usePersistenceStore((s) => s.currentDocumentId);
  const font = useDocumentFont();
  return useMemo(() => {
    const exportSettings = documentId ? loadDocumentPdfSettings(documentId) : null;
    const options: PDFExportOptions = { ...createInitialPDFOptions('', exportSettings), fontFamily: font };
    return paperOptions(options, resolvePageSetup(stored, exportSettings));
  }, [stored, documentId, font]);
}

interface Laid {
  layout: PdfLayout;
  /** The edited page's document it was laid out from. */
  doc: PMNode;
  pageId: string | undefined;
  /** The edited page's place among the pages. */
  index: number;
  /** The other pages' content as laid out; the cache keeps each the same object while its HTML is. */
  others: unknown[];
}

function othersOf(pages: PDFRichTextPage[], pageId: string | undefined): unknown[] {
  return pages.filter((page) => page.id !== pageId).map((page) => page.content.content);
}

function sameOthers(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((content, i) => content === b[i]);
}

function clearPaperVariables(column: HTMLElement): void {
  const names = Array.from({ length: column.style.length }, (_, i) => column.style.item(i));
  for (const name of names) if (name.startsWith('--paper-space-')) column.style.removeProperty(name);
}

export function usePaperLayout(editor: Editor | null, active: boolean, options: PDFExportOptions): void {
  useEffect(() => {
    if (!editor || !active || editor.isDestroyed) return;
    const view = editor.view;
    const column = view.dom.parentElement;
    if (!column) return;

    const overlay = document.createElement('div');
    overlay.className = 'paper-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    column.append(overlay);

    const geometry = paperGeometry(options);
    const cache: PageJsonCache = new Map();
    let laid: Laid | null = null;
    let disposed = false;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;

    const fit = () => {
      frame = undefined;
      if (!disposed) fitPages(view.dom, overlay, geometry);
    };
    const refit = () => {
      if (frame === undefined) frame = requestAnimationFrame(fit);
    };

    const layOut = async (): Promise<void> => {
      timer = undefined;
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const { paginate, relayoutFrom } = await import('../utils/pdfExport/paginate');
        const doc = editor.state.doc;
        const pageId = useRichTextPagesStore.getState().activePageId ?? undefined;
        const pages = collectPdfPages(editor, cache);
        const index = Math.max(0, pages.findIndex((page) => page.id === pageId));
        const others = othersOf(pages, pageId);
        const content = useRichTextStore.getState().content;
        const resumable = laid !== null && laid.pageId === pageId && laid.index === index && sameOthers(laid.others, others);
        const layout = resumable
          ? await relayoutFrom(
              laid!.layout,
              { ...(pageId !== undefined ? { pageId } : {}), block: firstChangedBlock(laid!.doc, doc) },
              options,
              content,
              undefined,
              pages,
              []
            )
          : await paginate(options, content, undefined, pages, []);
        if (disposed || editor.isDestroyed) return;
        if (editor.state.doc !== doc) {
          // An edit landed while laying out: this layout is already old.
          again = true;
          return;
        }
        laid = { layout, doc, pageId, index, others };
        setPaperPages(view, paperPagesFor(layout, pageId, index, doc, options));
        refit();
      } catch (error) {
        console.warn('[Paper Mode] Layout failed:', error);
      } finally {
        running = false;
        if (again && !disposed) {
          again = false;
          schedule();
        }
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void layOut(), PAPER_LAYOUT_DELAY_MS);
    };

    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      refit();
      schedule();
    };

    // Another prose page in the same editor (a local document): its breaks
    // aren't this page's, so they go until its own layout.
    const stopPages = useRichTextPagesStore.subscribe((state, previous) => {
      if (state.activePageId === previous.activePageId || disposed || editor.isDestroyed) return;
      setPaperPages(view, { ends: [], lastFooter: null });
      schedule();
    });

    editor.on('transaction', onTransaction);
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refit);
    resize?.observe(view.dom);
    const stopFonts = onFontLoad(refit);
    void layOut();

    return () => {
      disposed = true;
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      editor.off('transaction', onTransaction);
      stopPages();
      resize?.disconnect();
      stopFonts();
      overlay.remove();
      clearPaperVariables(column);
      if (!editor.isDestroyed) setPaperPages(view, { ends: [], lastFooter: null });
    };
  }, [editor, active, options]);
}
