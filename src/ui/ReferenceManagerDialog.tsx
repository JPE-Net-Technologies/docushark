/**
 * ReferenceManagerDialog (JP-89 slice 5).
 *
 * Modal for managing the document's reference library: add by DOI, import
 * BibTeX / CSL-JSON, pick the citation style, and list / remove references.
 * Follows the `createPortal` + `{ onClose }` dialog convention
 * (cf. `InsertLinkDialog`). Operates on `referenceStore` directly — no editor.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Plus, Trash2 } from 'lucide-react';
import { Icon } from './icons';
import { useReferenceStore } from '../store/referenceStore';
import { CITATION_STYLES, type CitationStyle } from '../types/Citation';
import { referencePreview } from '../services/citations/preview';
import { parseReferences, resolveDoi, type IngestResult } from '../services/citations/ingest';
import { importReferences } from '../services/citations/referenceImport';
import { useNotificationStore } from '../store/notificationStore';
import './ReferenceManagerDialog.css';

export interface ReferenceManagerDialogProps {
  onClose: () => void;
}

export function ReferenceManagerDialog({ onClose }: ReferenceManagerDialogProps) {
  const items = useReferenceStore((s) => s.items);
  const itemOrder = useReferenceStore((s) => s.itemOrder);
  const activeStyle = useReferenceStore((s) => s.activeStyle);
  const setStyle = useReferenceStore((s) => s.setStyle);
  const removeReference = useReferenceStore((s) => s.removeReference);

  // Derive the ordered list in render — never return a fresh array from the
  // selector (would trip zustand's "getSnapshot should be cached" loop).
  const references = useMemo(
    () => itemOrder.map((id) => items[id]).filter((r): r is NonNullable<typeof r> => r !== undefined),
    [items, itemOrder],
  );

  const [doi, setDoi] = useState('');
  const [doiLoading, setDoiLoading] = useState(false);
  const [text, setText] = useState('');
  const [textLoading, setTextLoading] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const reportIngest = useCallback((result: IngestResult) => {
    const notify = useNotificationStore.getState();
    if (result.report.errors.length > 0) {
      notify.error(result.report.errors.join('; '));
      return;
    }
    if (result.items.length === 0) {
      notify.info('No references found');
      return;
    }
    const { added, duplicates } = importReferences(result.items);
    if (added === 0 && duplicates > 0) {
      notify.info('Already in your library');
      return;
    }
    const bits = [`Added ${added} reference${added === 1 ? '' : 's'}`];
    if (duplicates > 0) bits.push(`${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped`);
    if (result.report.warnings.length > 0) bits.push(result.report.warnings.join('; '));
    notify.success(bits.join(' · '));
  }, []);

  const lookupDoi = useCallback(async () => {
    const value = doi.trim();
    if (!value || doiLoading) return;
    setDoiLoading(true);
    try {
      reportIngest(await resolveDoi(value));
      setDoi('');
    } finally {
      setDoiLoading(false);
    }
  }, [doi, doiLoading, reportIngest]);

  const importText = useCallback(async () => {
    const value = text.trim();
    if (!value || textLoading) return;
    setTextLoading(true);
    try {
      reportIngest(await parseReferences(value));
      setText('');
    } finally {
      setTextLoading(false);
    }
  }, [text, textLoading, reportIngest]);

  return createPortal(
    <div className="reference-manager-overlay" onMouseDown={onClose}>
      <div
        className="reference-manager"
        role="dialog"
        aria-label="Manage references"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="reference-manager-header">
          <h3>
            <Icon icon={BookOpen} size={16} /> References
          </h3>
          <button className="reference-manager-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="reference-manager-body">
          {/* Add by DOI */}
          <div className="reference-manager-field">
            <label htmlFor="ref-doi">Add by DOI</label>
            <div className="reference-manager-row">
              <input
                id="ref-doi"
                type="text"
                value={doi}
                onChange={(e) => setDoi(e.target.value)}
                placeholder="10.1000/xyz or https://doi.org/…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void lookupDoi();
                }}
              />
              <button
                className="reference-manager-btn primary"
                onClick={() => void lookupDoi()}
                disabled={doiLoading || !doi.trim()}
              >
                {doiLoading ? 'Looking up…' : 'Look up'}
              </button>
            </div>
          </div>

          {/* Import BibTeX / CSL-JSON */}
          <div className="reference-manager-field">
            <label htmlFor="ref-import">Import BibTeX or CSL-JSON</label>
            <textarea
              id="ref-import"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'@article{…}  or  [{"id":"…","type":"article-journal",…}]'}
              rows={4}
            />
            <button
              className="reference-manager-btn"
              onClick={() => void importText()}
              disabled={textLoading || !text.trim()}
            >
              <Icon icon={Plus} size={14} /> {textLoading ? 'Importing…' : 'Import'}
            </button>
          </div>

          {/* Style selector */}
          <div className="reference-manager-field">
            <label htmlFor="ref-style">Citation style</label>
            <select
              id="ref-style"
              value={activeStyle}
              onChange={(e) => setStyle(e.target.value as CitationStyle)}
            >
              {CITATION_STYLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {/* Reference list */}
          <div className="reference-manager-field">
            <label>
              Library ({references.length})
            </label>
            {references.length === 0 ? (
              <p className="reference-manager-empty">
                No references yet. Add one by DOI or paste BibTeX / CSL-JSON above.
              </p>
            ) : (
              <ul className="reference-manager-list">
                {references.map((ref) => (
                  <li key={ref.id} className="reference-manager-item">
                    <span className="reference-manager-item-text" title={referencePreview(ref)}>
                      {referencePreview(ref)}
                    </span>
                    <button
                      className="reference-manager-item-remove"
                      onClick={() => removeReference(ref.id)}
                      aria-label={`Remove ${ref.id}`}
                      title="Remove"
                    >
                      <Icon icon={Trash2} size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
