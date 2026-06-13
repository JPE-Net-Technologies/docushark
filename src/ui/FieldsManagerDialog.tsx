/**
 * FieldsManagerDialog (Phase 3 — Document Fields).
 *
 * Modal for managing the document's field library: define named values, edit
 * them in place (every `{{name}}` reference repaints live), insert a reference
 * at the caret, and insert the built-in computed fields (`today` / `now`).
 * Follows the `createPortal` + `{ onClose }` dialog convention
 * (cf. `ReferenceManagerDialog`). Operates on `fieldStore` directly; takes the
 * editor only to insert a reference.
 *
 * v1 is client-side only — a banner notes that fields aren't yet settable or
 * insertable via MCP/agents (planned). The data model is kept forward-compatible
 * so that work is purely additive.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { Braces, Info, Plus, Trash2 } from 'lucide-react';
import { Icon } from './icons';
import { useFieldStore } from '../store/fieldStore';
import { COMPUTED_FIELDS } from '../types/Field';
import './FieldsManagerDialog.css';

export interface FieldsManagerDialogProps {
  editor: Editor;
  onClose: () => void;
}

export function FieldsManagerDialog({ editor, onClose }: FieldsManagerDialogProps) {
  const fields = useFieldStore((s) => s.fields);
  const order = useFieldStore((s) => s.order);
  const setField = useFieldStore((s) => s.setField);
  const removeField = useFieldStore((s) => s.removeField);

  // Derive the ordered list in render — never return a fresh array from the
  // selector (would trip zustand's "getSnapshot should be cached" loop).
  const list = useMemo(
    () => order.map((name) => fields[name]).filter((f): f is NonNullable<typeof f> => f !== undefined),
    [fields, order],
  );

  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const insertField = useCallback(
    (name: string) => {
      editor.chain().focus().setFieldRef(name).run();
      onClose();
    },
    [editor, onClose],
  );

  const addField = useCallback(() => {
    const name = newName.trim();
    if (!name) return;
    setField(name, newValue);
    setNewName('');
    setNewValue('');
  }, [newName, newValue, setField]);

  const nameExists = useMemo(
    () => list.some((f) => f.name.toLowerCase() === newName.trim().toLowerCase()),
    [list, newName],
  );

  return createPortal(
    <div className="fields-manager-overlay" onMouseDown={onClose}>
      <div
        className="fields-manager"
        role="dialog"
        aria-label="Manage fields"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="fields-manager-header">
          <h3>
            <Icon icon={Braces} size={16} /> Fields
          </h3>
          <button className="fields-manager-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="fields-manager-body">
          {/* MCP scope note — v1 is client-side only. */}
          <p className="fields-manager-banner">
            <Icon icon={Info} size={14} />
            <span>
              Fields are stored with this document and update everywhere they’re used.
              Setting or inserting fields through MCP / agents isn’t supported yet.
            </span>
          </p>

          {/* Field list */}
          <div className="fields-manager-field">
            <label>Document fields ({list.length})</label>
            {list.length === 0 ? (
              <p className="fields-manager-empty">
                No fields yet. Add one below, or type <code>{'{{'}</code> in the editor.
              </p>
            ) : (
              <ul className="fields-manager-list">
                {list.map((field) => (
                  <li key={field.name} className="fields-manager-item">
                    <span className="fields-manager-item-name" title={field.name}>
                      {field.name}
                    </span>
                    <input
                      className="fields-manager-item-value"
                      type="text"
                      value={field.value}
                      placeholder="value"
                      onChange={(e) => setField(field.name, e.target.value)}
                      aria-label={`Value for ${field.name}`}
                    />
                    <button
                      className="fields-manager-btn"
                      onClick={() => insertField(field.name)}
                      title="Insert at cursor"
                    >
                      Insert
                    </button>
                    <button
                      className="fields-manager-item-remove"
                      onClick={() => removeField(field.name)}
                      aria-label={`Remove ${field.name}`}
                      title="Remove"
                    >
                      <Icon icon={Trash2} size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Add a field */}
          <div className="fields-manager-field">
            <label htmlFor="field-new-name">Add a field</label>
            <div className="fields-manager-row">
              <input
                id="field-new-name"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="name (e.g. Company)"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addField();
                }}
              />
              <input
                type="text"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="value (e.g. Acme Inc.)"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addField();
                }}
              />
              <button
                className="fields-manager-btn primary"
                onClick={addField}
                disabled={!newName.trim()}
              >
                <Icon icon={Plus} size={14} /> {nameExists ? 'Update' : 'Add'}
              </button>
            </div>
          </div>

          {/* Computed fields */}
          <div className="fields-manager-field">
            <label>Computed fields</label>
            <ul className="fields-manager-list">
              {COMPUTED_FIELDS.map((c) => (
                <li key={c.name} className="fields-manager-item">
                  <span className="fields-manager-item-name" title={c.name}>
                    {c.name}
                  </span>
                  <span className="fields-manager-item-computed">{c.label} · {c.resolve()}</span>
                  <button
                    className="fields-manager-btn"
                    onClick={() => insertField(c.name)}
                    title="Insert at cursor"
                  >
                    Insert
                  </button>
                </li>
              ))}
            </ul>
            <p className="fields-manager-hint">
              Computed fields resolve live and take precedence over a field of the same name.
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
