/**
 * CollectionActionsMenu — the three-dots actions menu for a single collection
 * (rename / recolour / delete). Shared by the group-by `CollectionSection` in
 * `DocumentList` and the Collections rail in `DocumentsHome` so both surfaces
 * stay in lockstep (JP-380). Presentational: the host owns the open state (one
 * menu open at a time, keyed off the model's `activeCollectionMenu`) and the
 * action handlers; this component just renders the trigger + dropdown and
 * closes itself on an outside click.
 *
 * Reuses the global `document-browser__*` classes from `DocumentBrowser.css`.
 */

import { useRef, useEffect } from 'react';
import { MoreHorizontal, X } from 'lucide-react';
import { COLLECTION_SWATCHES, type Collection } from '../../store/collectionStore';

interface CollectionActionsMenuProps {
  collection: Collection;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onRename: (collection: Collection) => void;
  onDelete: (collection: Collection) => void;
  onRecolor: (collection: Collection, color: string | undefined) => void;
}

export function CollectionActionsMenu({
  collection,
  isOpen,
  onOpen,
  onClose,
  onRename,
  onDelete,
  onRecolor,
}: CollectionActionsMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [isOpen, onClose]);

  return (
    <div className="document-browser__section-menu-wrap" ref={menuRef}>
      <button
        className="document-browser__section-menu-btn"
        onClick={onOpen}
        title="Collection actions"
        aria-label="Collection actions"
        aria-haspopup="menu"
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {isOpen && (
        <div className="document-browser__section-menu" role="menu">
          <button className="document-browser__assign-item" onClick={() => onRename(collection)}>
            Rename…
          </button>
          <div className="document-browser__assign-sep" />
          <div className="document-browser__swatch-row">
            {COLLECTION_SWATCHES.map((color) => (
              <button
                key={color}
                className="document-browser__swatch"
                style={{ background: color }}
                onClick={() => onRecolor(collection, color)}
                title={color}
              />
            ))}
            <button
              className="document-browser__swatch document-browser__swatch--clear"
              onClick={() => onRecolor(collection, undefined)}
              title="Clear colour"
              aria-label="Clear colour"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
          <div className="document-browser__assign-sep" />
          <button
            className="document-browser__assign-item document-browser__assign-item--danger"
            onClick={() => onDelete(collection)}
          >
            Delete collection
          </button>
        </div>
      )}
    </div>
  );
}
