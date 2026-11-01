/**
 * MobileDocumentInfo — the document identity (name + rename + save status) as a
 * compact info popover for mobile (JP-332).
 *
 * On a narrow bar the inline document name collided with the Write/Split/Diagram
 * focus tabs on the right. Here the name moves behind an ⓘ button next to
 * Documents; tapping it opens a small popover to read the status and rename the
 * doc. The button keeps a dirty dot so unsaved state is still glanceable without
 * opening it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Icon } from '../icons';
import { usePersistenceStore, UNTITLED_DOCUMENT_NAME } from '../../store/persistenceStore';
import { useDocumentNamingStore } from '../../services/documentNaming';
import { useAutoSave } from '../../hooks/useAutoSave';
import './MobileDocumentInfo.css';

export function MobileDocumentInfo() {
  const currentDocumentName = usePersistenceStore((s) => s.currentDocumentName);
  const renameDocument = usePersistenceStore((s) => s.renameDocument);
  const { isDirty, status, saveNow } = useAutoSave();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentDocumentName);
  const wrapRef = useRef<HTMLDivElement>(null);

  // An unnamed document opens with a name suggested from its content (DSK-209).
  // Enter accepts the suggestion; closing renames only if the text was edited.
  const untitled = currentDocumentName === UNTITLED_DOCUMENT_NAME;
  const suggestion = useDocumentNamingStore((s) => s.suggestion);
  const titleEditRequest = useDocumentNamingStore((s) => s.titleEditRequest);
  const prefillRef = useRef(currentDocumentName);
  const openWithPrefill = useCallback(() => {
    const prefill = untitled && suggestion ? suggestion : currentDocumentName;
    prefillRef.current = prefill;
    setName(prefill);
    setOpen(true);
  }, [untitled, suggestion, currentDocumentName]);

  // The "Give this document a name?" prompt's Rename opens the chip here.
  const seenTitleEditRequest = useRef(titleEditRequest);
  useEffect(() => {
    if (titleEditRequest === seenTitleEditRequest.current) return;
    seenTitleEditRequest.current = titleEditRequest;
    openWithPrefill();
  }, [titleEditRequest, openWithPrefill]);

  // Keep the field in sync with external renames while the popover is closed.
  useEffect(() => {
    if (!open) setName(currentDocumentName);
  }, [currentDocumentName, open]);

  const commit = useCallback(
    (accept = false) => {
      const trimmed = name.trim();
      const edited = trimmed !== prefillRef.current.trim();
      if (trimmed && trimmed !== currentDocumentName && (accept || edited)) renameDocument(trimmed);
    },
    [name, currentDocumentName, renameDocument],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && !wrapRef.current?.contains(t)) {
        commit();
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setName(currentDocumentName);
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, commit, currentDocumentName]);

  const statusLabel = status === 'saving' ? 'Saving…' : isDirty ? 'Unsaved changes' : 'Saved';
  const statusState = status === 'saving' ? 'saving' : isDirty ? 'dirty' : 'saved';

  return (
    <div className="mobile-doc-info" ref={wrapRef}>
      {/* The document's name, truncated to the bar's spare width (DSK-197):
          behind a bare ⓘ the title of the open document wasn't on screen at
          all. Tapping it opens the same rename and status popover. */}
      <button
        type="button"
        className={`mobile-doc-info-btn${isDirty ? ' is-dirty' : ''}${untitled ? ' is-untitled' : ''}`}
        onClick={() => (open ? setOpen(false) : openWithPrefill())}
        title={untitled ? 'Name this document' : currentDocumentName}
        aria-label={`Document: ${currentDocumentName}. ${statusLabel}.`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="mobile-doc-info-name">{currentDocumentName}</span>
        <Icon icon={ChevronDown} size={14} aria-hidden="true" />
      </button>

      {open && (
        <div className="mobile-doc-info-pop" role="dialog" aria-label="Document info">
          <label className="mobile-doc-info-field">
            <span className="mobile-doc-info-label">Name</span>
            <input
              type="text"
              className="mobile-doc-info-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commit(true);
                  setOpen(false);
                }
              }}
            />
          </label>
          <div className="mobile-doc-info-status">
            <span className={`mobile-doc-info-dot ${statusState}`} aria-hidden="true" />
            <span>{statusLabel}</span>
            {isDirty && status !== 'saving' && (
              <button
                type="button"
                className="mobile-doc-info-save"
                onClick={() => {
                  commit();
                  saveNow();
                }}
              >
                Save now
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
