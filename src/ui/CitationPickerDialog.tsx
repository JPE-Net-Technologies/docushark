/**
 * CitationPickerDialog (JP-89 slice 5).
 *
 * Modal for inserting an inline citation: filter the document's references,
 * optionally add a locator (page/section), and insert. Follows the
 * `createPortal` + `{ editor, onClose }` dialog convention (cf. `InsertLinkDialog`).
 * When the library is empty it offers a shortcut to the Reference Manager.
 */

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { Quote } from 'lucide-react';
import { Icon } from './icons';
import { useReferenceStore } from '../store/referenceStore';
import { referencePreview } from '../services/citations/preview';
import * as cmd from './editorCommands';
import './CitationPickerDialog.css';

export interface CitationPickerDialogProps {
  editor: Editor;
  onClose: () => void;
  /** Opens the Reference Manager (from the empty-state shortcut). */
  onManageReferences: () => void;
}

export function CitationPickerDialog({ editor, onClose, onManageReferences }: CitationPickerDialogProps) {
  const items = useReferenceStore((s) => s.items);
  const itemOrder = useReferenceStore((s) => s.itemOrder);

  const references = useMemo(
    () => itemOrder.map((id) => items[id]).filter((r): r is NonNullable<typeof r> => r !== undefined),
    [items, itemOrder],
  );

  const [filter, setFilter] = useState('');
  const [locator, setLocator] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return references;
    return references.filter((r) => referencePreview(r).toLowerCase().includes(q));
  }, [references, filter]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const insert = (refId: string) => {
    cmd.setCitation(editor, refId, locator.trim() || undefined);
    onClose();
  };

  return createPortal(
    <div className="citation-picker-overlay" onMouseDown={onClose}>
      <div
        className="citation-picker"
        role="dialog"
        aria-label="Insert citation"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="citation-picker-header">
          <h3>
            <Icon icon={Quote} size={16} /> Insert Citation
          </h3>
          <button className="citation-picker-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="citation-picker-body">
          {references.length === 0 ? (
            <div className="citation-picker-empty">
              <p>No references yet.</p>
              <button
                className="citation-picker-manage"
                onClick={() => {
                  onClose();
                  onManageReferences();
                }}
              >
                Add references…
              </button>
            </div>
          ) : (
            <>
              <input
                type="text"
                className="citation-picker-filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search references…"
                autoFocus
              />
              <div className="citation-picker-locator">
                <label htmlFor="citation-locator">Locator (optional)</label>
                <input
                  id="citation-locator"
                  type="text"
                  value={locator}
                  onChange={(e) => setLocator(e.target.value)}
                  placeholder="p. 42"
                />
              </div>
              {filtered.length === 0 ? (
                <p className="citation-picker-noresults">No matches.</p>
              ) : (
                <ul className="citation-picker-list">
                  {filtered.map((ref) => (
                    <li key={ref.id}>
                      <button className="citation-picker-item" onClick={() => insert(ref.id)}>
                        {referencePreview(ref)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
