/**
 * PdfSidebar — tabbed side panel for the PDF reader. Ships with the document
 * Outline tab; the Bookmarks tab joins it with the reading-state work.
 */

import type { PdfOutlineNode } from './usePdfViewerController';

export interface PdfSidebarProps {
  outline: PdfOutlineNode[] | null;
  onNavigate: (dest: unknown) => void;
}

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

export function PdfSidebar({ outline, onNavigate }: PdfSidebarProps) {
  return (
    <div className="pdf-reader__sidebar">
      <div className="pdf-reader__sidebar-tabs" role="tablist">
        <button
          className="pdf-reader__sidebar-tab pdf-reader__sidebar-tab--active"
          role="tab"
          aria-selected="true"
        >
          Outline
        </button>
      </div>
      <div className="pdf-reader__sidebar-content" role="tabpanel">
        {outline && outline.length > 0 ? (
          <OutlineList items={outline} onNavigate={onNavigate} depth={0} />
        ) : (
          <div className="pdf-reader__sidebar-empty">
            No outline in this document.
          </div>
        )}
      </div>
    </div>
  );
}
