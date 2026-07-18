/**
 * Cite-a-PDF orchestration: sniff a DOI (and title) out of an embedded PDF's
 * metadata + first pages, resolve it to CSL-JSON via the existing DOI pipeline,
 * and import it into the document's reference library.
 *
 * Parses the PDF independently of the viewer (pdf.js lazy-imported, same as
 * ThumbnailGenerator) so the file-viewer header can offer "Cite" without
 * coupling to the reader's internals. A one-click action on a paper-sized PDF
 * parses in well under a second; not worth sharing the viewer's instance.
 */

import { resolveDoi } from './ingest';
import { importReferences } from './referenceImport';
import { extractLikelyDoi } from './pdfDoiExtract';
import type { CSLItem } from '../../types/Citation';

export interface PdfCitationHints {
  doi: string | null;
  title: string | null;
}

export type CitePdfStatus = 'added' | 'duplicate' | 'no-doi' | 'resolve-failed';

export interface CitePdfResult {
  status: CitePdfStatus;
  doi: string | null;
  title: string | null;
}

/** Metadata fields worth scanning for a DOI, in priority order. */
const METADATA_DOI_FIELDS = ['doi', 'DOI', 'Subject', 'Keywords', 'Title'] as const;

/** How many leading pages of text to scan (papers put the DOI on page 1-2). */
const PAGES_TO_SCAN = 2;

/**
 * Extract DOI + title hints from PDF bytes. Metadata fields are scanned before
 * page text so a document-declared DOI outranks DOIs of cited works.
 */
export async function extractPdfCitationHints(data: ArrayBuffer): Promise<PdfCitationHints> {
  const pdfjsLib = await import('pdfjs-dist');
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
  }

  const loadingTask = pdfjsLib.getDocument({ data });
  try {
    const doc = await loadingTask.promise;
    const sources: string[] = [];
    let title: string | null = null;

    try {
      const meta = await doc.getMetadata();
      const info = (meta.info ?? {}) as Record<string, unknown>;
      const rawTitle = info['Title'];
      if (typeof rawTitle === 'string' && rawTitle.trim() !== '') {
        title = rawTitle.trim();
      }
      for (const field of METADATA_DOI_FIELDS) {
        const value = info[field];
        if (typeof value === 'string') sources.push(value);
      }
    } catch {
      /* metadata is optional */
    }

    const pageCount = Math.min(PAGES_TO_SCAN, doc.numPages);
    for (let p = 1; p <= pageCount; p++) {
      try {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        sources.push(
          content.items.map((item) => ('str' in item ? item.str : '')).join(' '),
        );
      } catch {
        /* a broken page shouldn't kill the whole extraction */
      }
    }

    return { doi: extractLikelyDoi(sources), title };
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

/** Resolve a DOI and import the result into the reference library. */
export async function citeDoi(doi: string): Promise<CitePdfStatus> {
  const result = await resolveDoi(doi);
  if (result.items.length === 0) return 'resolve-failed';
  const { added } = importReferences(result.items);
  return added > 0 ? 'added' : 'duplicate';
}

/** Full flow: extract hints from the PDF, then resolve + import its DOI. */
export async function citePdf(blob: Blob): Promise<CitePdfResult> {
  const hints = await extractPdfCitationHints(await blob.arrayBuffer());
  if (!hints.doi) return { status: 'no-doi', ...hints };
  const status = await citeDoi(hints.doi);
  return { status, ...hints };
}

/**
 * Fallback for DOI-less files: a minimal CSL item from the file's own
 * metadata, so the reference at least exists and can be enriched by hand.
 */
export function citeMinimal(fileName: string, title: string | null): CitePdfStatus {
  const item: CSLItem = {
    id: '',
    type: 'document',
    title: title ?? fileName.replace(/\.pdf$/i, ''),
  };
  const { added } = importReferences([item]);
  return added > 0 ? 'added' : 'duplicate';
}
