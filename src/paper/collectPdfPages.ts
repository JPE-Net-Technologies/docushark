/**
 * Every prose page of the open document, as the PDF export lays them out
 * (DSK-48): the page being edited from the live editor, the others from their
 * saved HTML. The export dialog and Paper Mode both use it, so Paper Mode lays
 * out exactly what the export would.
 */

import { generateJSON, type Editor, type JSONContent } from '@tiptap/core';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { RICH_TEXT_VERSION } from '../types/RichText';
import { extensions as tiptapExtensions } from '../ui/TiptapEditor';
import type { PDFRichTextPage } from '../utils/pdfExportUtils';

/** Parsed pages by id, reused while their HTML doesn't change. */
export type PageJsonCache = Map<string, { html: string; json: JSONContent }>;

export function collectPdfPages(editor: Editor | null, cache?: PageJsonCache): PDFRichTextPage[] {
  const pagesState = useRichTextPagesStore.getState();
  const pages: PDFRichTextPage[] = [];

  for (const pageId of pagesState.pageOrder) {
    const page = pagesState.pages[pageId];
    if (!page) continue;

    if (pageId === pagesState.activePageId && editor) {
      // Active page: use Tiptap JSON directly from editor (most accurate)
      pages.push({ id: page.id, name: page.name, content: { content: editor.getJSON(), version: RICH_TEXT_VERSION } });
      continue;
    }

    // Non-active pages: convert HTML to Tiptap JSON via generateJSON
    const html = page.content || '<p></p>';
    const cached = cache?.get(pageId);
    const json = cached && cached.html === html ? cached.json : generateJSON(html, tiptapExtensions);
    cache?.set(pageId, { html, json });
    pages.push({ id: page.id, name: page.name, content: { content: json, version: RICH_TEXT_VERSION } });
  }

  return pages;
}
