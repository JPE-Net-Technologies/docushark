/**
 * The status line's prose readout (DSK-211): the open page's word count (the
 * selection's against the page's while text is selected) and its place among
 * the document's pages. Clicking the count opens Document stats.
 *
 * The open page is counted live by `useProseStats`; the other pages from their
 * saved HTML, the same way version history counts them.
 */
import { useEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { useProseStatsStore, readingMinutes } from '../services/proseStats';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { usePageStore } from '../store/pageStore';
import { useDocumentStore } from '../store/documentStore';
import { countWordsInHtml } from '../utils/versionSummary';
import './DocumentStats.css';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function ProseReadout() {
  const stats = useProseStatsStore((s) => s.stats);
  const pageCount = useRichTextPagesStore((s) => s.pageOrder.length);
  const pageIndex = useRichTextPagesStore((s) => (s.activePageId ? s.pageOrder.indexOf(s.activePageId) : -1));
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // The status line clips its overflow (JP-486), so the popover is portalled
  // and placed above the count, kept on screen, like ToolbarDropdown's.
  const toggle = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!open && rect) {
      setPosition({
        bottom: window.innerHeight - rect.top + 8,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8)),
      });
    }
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!stats) return null;
  const words =
    stats.selectionWords > 0
      ? `${stats.selectionWords.toLocaleString()} of ${plural(stats.words, 'word')}`
      : plural(stats.words, 'word');

  return (
    <div className="document-stats" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="status-bar-btn document-stats-trigger"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Document stats"
      >
        {words}
      </button>
      {pageCount > 1 && pageIndex >= 0 && (
        <span className="status-bar-info">
          Page {pageIndex + 1} of {pageCount}
        </span>
      )}
      {open && createPortal(<DocumentStatsPopover popoverRef={popoverRef} style={position} />, document.body)}
    </div>
  );
}

/** The popover's width, for keeping it on screen; matches DocumentStats.css. */
const POPOVER_WIDTH = 240;

function DocumentStatsPopover({ popoverRef, style }: { popoverRef: Ref<HTMLDivElement>; style: CSSProperties }) {
  const stats = useProseStatsStore((s) => s.stats);
  const pages = useRichTextPagesStore((s) => s.pages);
  const pageOrder = useRichTextPagesStore((s) => s.pageOrder);
  const activePageId = useRichTextPagesStore((s) => s.activePageId);
  const canvasPages = usePageStore((s) => s.pageOrder.length);
  const shapes = useDocumentStore((s) => s.shapeOrder.length);
  if (!stats) return null;

  const perPage = pageOrder
    .map((id) => pages[id])
    .filter((page): page is NonNullable<typeof page> => !!page)
    .map((page) => ({
      id: page.id,
      name: page.name,
      words: page.id === activePageId ? stats.words : countWordsInHtml(page.content),
    }));
  const totalWords = perPage.reduce((sum, page) => sum + page.words, 0) || stats.words;
  const minutes = readingMinutes(stats.words);

  return (
    <div ref={popoverRef} style={style} className="document-stats-popover" role="dialog" aria-label="Document stats">
      <div className="document-stats-heading">This page</div>
      <dl className="document-stats-grid">
        <dt>Words</dt>
        <dd>{stats.words.toLocaleString()}</dd>
        <dt>Characters</dt>
        <dd>{stats.characters.toLocaleString()}</dd>
        <dt>Paragraphs</dt>
        <dd>{stats.paragraphs.toLocaleString()}</dd>
        <dt>Reading time</dt>
        <dd>{minutes === 0 ? '—' : `About ${plural(minutes, 'minute')}`}</dd>
      </dl>
      {perPage.length > 1 && (
        <>
          <div className="document-stats-heading">Pages</div>
          <dl className="document-stats-grid">
            {perPage.map((page) => (
              <div key={page.id} className="document-stats-row">
                <dt className={page.id === activePageId ? 'is-current' : undefined}>{page.name}</dt>
                <dd>{page.words.toLocaleString()}</dd>
              </div>
            ))}
            <div className="document-stats-row document-stats-total">
              <dt>All pages</dt>
              <dd>{plural(totalWords, 'word')}</dd>
            </div>
          </dl>
        </>
      )}
      <div className="document-stats-heading">Canvas</div>
      <p className="document-stats-line">
        {plural(canvasPages, 'page')} · {plural(shapes, 'shape')} on this page
      </p>
    </div>
  );
}
