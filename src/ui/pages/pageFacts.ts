/**
 * What a page's hover card, and its menu on touch, say about it (DSK-260):
 * its kind, its size, and where it prints.
 *
 * "Where it prints" counts pages, never printed sheets ("2nd of 6 in the
 * PDF"), so it can't be confused with Paper Mode's page numbers. Writing pages
 * print in order. Diagrams print as one block before or after the writing, or
 * not at all, as the document's PDF settings say, and empty ones are skipped.
 */

import { useCollaborationStore } from '../../collaboration/collaborationStore';
import { useDocumentStore } from '../../store/documentStore';
import { usePageStore } from '../../store/pageStore';
import { visiblePageIds } from '../../store/pendingPageDeleteStore';
import { loadDocumentPdfSettings, usePersistenceStore } from '../../store/persistenceStore';
import { useRichTextPagesStore } from '../../store/richTextPagesStore';
import { countWordsInHtml } from '../../utils/versionSummary';
import type { PageKind } from './pageLabel';

export interface PageFacts {
  kind: string;
  size: string;
  print: string;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal(n: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? 'th'}`;
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function sharedDoc() {
  const collab = useCollaborationStore.getState();
  return collab.isActive ? collab.getYjsDocument() : null;
}

function wordsOn(pageId: string): number {
  const shared = sharedDoc();
  if (shared) return shared.getProsePageSummary(pageId).words;
  return countWordsInHtml(useRichTextPagesStore.getState().pages[pageId]?.content ?? '');
}

/** Top-level shapes, as the status bar counts them. */
function shapesOn(pageId: string): number {
  const canvas = usePageStore.getState();
  if (canvas.activePageId === pageId) return useDocumentStore.getState().shapeOrder.length;
  const shared = sharedDoc();
  if (shared) return shared.getShapeOrderForPage(pageId).length;
  return canvas.pages[pageId]?.shapeOrder.length ?? 0;
}

interface DiagramPlacement {
  included: boolean;
  /** Before the writing (after the cover, or before the content), else after it. */
  before: boolean;
}

// The PDF settings live in the saved document; parsing it on every hover would
// be wasteful, and they change only in the export dialog.
let placementCache: { docId: string; at: number; placement: DiagramPlacement } | null = null;
const PLACEMENT_CACHE_MS = 5_000;

function diagramPlacement(): DiagramPlacement {
  const docId = usePersistenceStore.getState().currentDocumentId;
  if (!docId) return { included: false, before: true };
  const now = Date.now();
  if (placementCache && placementCache.docId === docId && now - placementCache.at < PLACEMENT_CACHE_MS) {
    return placementCache.placement;
  }
  const embed = loadDocumentPdfSettings(docId)?.diagramEmbed;
  const placement = { included: embed?.enabled === true, before: embed?.position !== 'after-content' };
  placementCache = { docId, at: now, placement };
  return placement;
}

export function pageFacts(kind: PageKind, pageId: string): PageFacts {
  const placement = diagramPlacement();
  const writing = visiblePageIds('prose');
  const diagrams = placement.included ? visiblePageIds('canvas').filter((id) => shapesOn(id) > 0) : [];
  const total = writing.length + diagrams.length;

  if (kind === 'prose') {
    const position = (placement.included && placement.before ? diagrams.length : 0) + writing.indexOf(pageId) + 1;
    return { kind: 'Writing page', size: count(wordsOn(pageId), 'word', 'words'), print: `${ordinal(position)} of ${total} in the PDF` };
  }

  const shapes = shapesOn(pageId);
  const at = diagrams.indexOf(pageId) + 1;
  const print = !placement.included
    ? 'Not in the PDF'
    : at === 0
      ? 'Not in the PDF while it’s empty'
      : `${ordinal((placement.before ? 0 : writing.length) + at)} of ${total} in the PDF`;
  return { kind: 'Diagram', size: count(shapes, 'shape', 'shapes'), print };
}

/** The facts as one line, for a menu heading or a sheet's subtitle. */
export function factsLine(facts: PageFacts): string {
  return `${facts.kind} · ${facts.size} · ${facts.print}`;
}

/** Forget the cached PDF placement (tests). */
export function __resetPageFactsCache(): void {
  placementCache = null;
}
