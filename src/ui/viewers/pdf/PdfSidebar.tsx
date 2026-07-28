/**
 * PdfSidebar — tabbed side panel for the PDF reader: the document's own
 * Outline, and the user's page Bookmarks (per-user reading state). The
 * Bookmarks tab only appears when the host provides bookmark props (i.e.
 * reading-state persistence is available).
 */

import { useState } from 'react';
import { Bookmark, Pencil, Trash2 } from 'lucide-react';
import { Icon } from '../../icons';
import type { PdfBookmark } from '../../../store/fileViewState';
import type { PdfOutlineNode } from './usePdfViewerController';

export interface PdfSidebarProps {
  outline: PdfOutlineNode[] | null;
  onNavigate: (dest: unknown) => void;
  /** Undefined disables the Bookmarks tab entirely. */
  bookmarks?: PdfBookmark[] | undefined;
  currentPage?: number | undefined;
  onJumpToPage?: ((page: number) => void) | undefined;
  onRenameBookmark?: ((page: number, label: string) => void) | undefined;
  onRemoveBookmark?: ((page: number) => void) | undefined;
  onBookmarkCurrent?: (() => void) | undefined;
}

type SidebarTab = 'outline' | 'bookmarks';

function OutlineList({
  items,
  onNavigate,
  depth,
}: {
  items: PdfOutlineNode[];
  onNavigate: (dest: unknown) => void;
  depth: number;
}) {
  return (
    <ul className="pdf-reader__outline-list" role={depth === 0 ? 'tree' : 'group'}>
      {items.map((item, i) => (
        <li key={`${depth}-${i}-${item.title}`} role="treeitem">
          <button
            className="pdf-reader__outline-item"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() => onNavigate(item.dest)}
            title={item.title}
          >
            {item.title || 'Untitled section'}
          </button>
          {item.items.length > 0 && (
            <OutlineList items={item.items} onNavigate={onNavigate} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}

function BookmarkRow({
  bookmark,
  isCurrent,
  onJump,
  onRename,
  onRemove,
}: {
  bookmark: PdfBookmark;
  isCurrent: boolean;
  onJump: () => void;
  onRename: (label: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bookmark.label ?? '');

  const commit = () => {
    setEditing(false);
    onRename(draft);
  };

  if (editing) {
    return (
      <li className="pdf-reader__bookmark-row">
        <input
          className="pdf-reader__bookmark-rename"
          value={draft}
          placeholder={`Page ${bookmark.page}`}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(false);
              setDraft(bookmark.label ?? '');
            }
          }}
          aria-label={`Rename bookmark on page ${bookmark.page}`}
        />
      </li>
    );
  }

  return (
    <li className="pdf-reader__bookmark-row">
      <button
        className="pdf-reader__bookmark-jump"
        onClick={onJump}
        aria-current={isCurrent ? 'page' : undefined}
        title={`Go to page ${bookmark.page}`}
      >
        <span className="pdf-reader__bookmark-page">p. {bookmark.page}</span>
        <span className="pdf-reader__bookmark-label">
          {bookmark.label ?? `Page ${bookmark.page}`}
        </span>
      </button>
      <span className="pdf-reader__bookmark-actions">
        <button
          className="pdf-reader__bookmark-action"
          onClick={() => {
            setDraft(bookmark.label ?? '');
            setEditing(true);
          }}
          title="Rename bookmark"
        >
          <Icon icon={Pencil} size={13} />
        </button>
        <button
          className="pdf-reader__bookmark-action"
          onClick={onRemove}
          title="Delete bookmark"
        >
          <Icon icon={Trash2} size={13} />
        </button>
      </span>
    </li>
  );
}

export function PdfSidebar({
  outline,
  onNavigate,
  bookmarks,
  currentPage,
  onJumpToPage,
  onRenameBookmark,
  onRemoveBookmark,
  onBookmarkCurrent,
}: PdfSidebarProps) {
  const bookmarksEnabled = bookmarks !== undefined;
  const [activeTab, setActiveTab] = useState<SidebarTab>('outline');
  const tab: SidebarTab = bookmarksEnabled ? activeTab : 'outline';

  return (
    <div className="pdf-reader__sidebar">
      <div className="pdf-reader__sidebar-tabs" role="tablist">
        <button
          className={`pdf-reader__sidebar-tab${tab === 'outline' ? ' pdf-reader__sidebar-tab--active' : ''}`}
          role="tab"
          aria-selected={tab === 'outline'}
          onClick={() => setActiveTab('outline')}
        >
          Outline
        </button>
        {bookmarksEnabled && (
          <button
            className={`pdf-reader__sidebar-tab${tab === 'bookmarks' ? ' pdf-reader__sidebar-tab--active' : ''}`}
            role="tab"
            aria-selected={tab === 'bookmarks'}
            onClick={() => setActiveTab('bookmarks')}
          >
            Bookmarks
          </button>
        )}
      </div>

      <div className="pdf-reader__sidebar-content" role="tabpanel">
        {tab === 'outline' &&
          (outline && outline.length > 0 ? (
            <OutlineList items={outline} onNavigate={onNavigate} depth={0} />
          ) : (
            <div className="pdf-reader__sidebar-empty">
              No outline in this document.
              {bookmarksEnabled && ' Use bookmarks to mark pages yourself.'}
            </div>
          ))}

        {tab === 'bookmarks' && bookmarksEnabled && (
          <>
            {onBookmarkCurrent && (
              <button className="pdf-reader__bookmark-add" onClick={onBookmarkCurrent}>
                <Icon icon={Bookmark} size={14} />
                Bookmark current page
              </button>
            )}
            {bookmarks.length > 0 ? (
              <ul className="pdf-reader__bookmark-list">
                {bookmarks.map((b) => (
                  <BookmarkRow
                    key={b.page}
                    bookmark={b}
                    isCurrent={b.page === currentPage}
                    onJump={() => onJumpToPage?.(b.page)}
                    onRename={(label) => onRenameBookmark?.(b.page, label)}
                    onRemove={() => onRemoveBookmark?.(b.page)}
                  />
                ))}
              </ul>
            ) : (
              <div className="pdf-reader__sidebar-empty">
                No bookmarks yet. Press <kbd>b</kbd> while reading to mark a page.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
