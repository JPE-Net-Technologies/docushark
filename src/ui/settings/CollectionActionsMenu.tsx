/**
 * CollectionActionsMenu — the three-dots actions menu for a single collection
 * (rename / recolour / delete). Shared by the group-by `CollectionSection` in
 * `DocumentList` and the Collections rail in `DocumentsHome` so both surfaces
 * stay in lockstep (JP-380). Presentational: the host owns the open state (one
 * menu open at a time, keyed off the model's `activeCollectionMenu`) and the
 * action handlers; this component just renders the trigger + dropdown and
 * closes itself on an outside click.
 *
 * On a phone (the JP-332 mobile chrome) the same actions open as a bottom
 * sheet instead (DSK-196), like every `DropdownMenu`: the popup's 18px colour
 * dots and 30px rows were made for a mouse. This menu isn't a `DropdownMenu`
 * because the colour row isn't a list of actions, so it builds its own sheet.
 *
 * Reuses the global `document-browser__*` classes from `DocumentBrowser.css`,
 * and the action-sheet rows from `DropdownMenuSheet.css`.
 */

import { useRef, useEffect, useMemo } from 'react';
import { Check, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import {
  COLLECTION_SWATCHES,
  COLLECTION_SWATCH_NAMES,
  type Collection,
} from '../../store/collectionStore';
import { readMobileActive } from '../layout/useMobileAdaptation';
import { MobileSheet } from '../mobile/MobileSheet';
import '../components/DropdownMenuSheet.css';

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
  // Decided as the menu opens, like DropdownMenu's presentation.
  const asSheet = useMemo(() => isOpen && readMobileActive(), [isOpen]);

  useEffect(() => {
    // The sheet is portaled outside `menuRef` and brings its own scrim; this
    // listener would close it on the first tap inside it.
    if (!isOpen || asSheet) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [isOpen, asSheet, onClose]);

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
      {isOpen && asSheet && (
        <CollectionActionsSheet
          collection={collection}
          onClose={onClose}
          onRename={onRename}
          onDelete={onDelete}
          onRecolor={onRecolor}
        />
      )}
      {isOpen && !asSheet && (
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

type SheetProps = Omit<CollectionActionsMenuProps, 'isOpen' | 'onOpen'>;

/**
 * The phone presentation. Each choice closes the sheet before its action runs:
 * Rename and Delete open dialogs, and the sheet sits on the dropdown layer,
 * above the dialog host, so a dialog opened under it would be hidden.
 */
function CollectionActionsSheet({ collection, onClose, onRename, onDelete, onRecolor }: SheetProps) {
  const choose = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <MobileSheet placement="bottom" title={collection.name} subtitle="Collection" onClose={onClose}>
      <div className="dropdown-sheet__list" role="menu" aria-label={collection.name}>
        <button
          type="button"
          role="menuitem"
          className="dropdown-sheet__item"
          onClick={choose(() => onRename(collection))}
        >
          <span className="dropdown-sheet__icon">
            <Pencil size={16} aria-hidden="true" />
          </span>
          <span className="dropdown-sheet__label">Rename…</span>
        </button>
        <div className="dropdown-sheet__heading" role="presentation">
          Colour
        </div>
        <div className="collection-sheet__swatches" role="group" aria-label="Colour">
          {COLLECTION_SWATCHES.map((color) => {
            const current = collection.color === color;
            return (
              <button
                key={color}
                type="button"
                className={`collection-sheet__swatch${current ? ' collection-sheet__swatch--current' : ''}`}
                style={{ background: color }}
                aria-label={COLLECTION_SWATCH_NAMES[color] ?? color}
                aria-pressed={current}
                onClick={choose(() => onRecolor(collection, color))}
              >
                {current && <Check size={18} aria-hidden="true" />}
              </button>
            );
          })}
          <button
            type="button"
            className="collection-sheet__swatch collection-sheet__swatch--clear"
            aria-label="No colour"
            aria-pressed={!collection.color}
            onClick={choose(() => onRecolor(collection, undefined))}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="dropdown-sheet__separator" role="separator" />
        <button
          type="button"
          role="menuitem"
          className="dropdown-sheet__item dropdown-sheet__item--danger"
          onClick={choose(() => onDelete(collection))}
        >
          <span className="dropdown-sheet__icon">
            <Trash2 size={16} aria-hidden="true" />
          </span>
          <span className="dropdown-sheet__label">Delete collection…</span>
        </button>
      </div>
    </MobileSheet>
  );
}
