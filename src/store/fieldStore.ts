/**
 * fieldStore - Per-document field library (Phase 3 — Document Fields).
 *
 * Holds the active document's named fields (the backing store for `{{field}}`
 * placeholders in prose). Modelled almost 1:1 on `referenceStore`: a pure
 * name-keyed map + order-array data store, serialized into
 * `DiagramDocument.fields` on save and reloaded / cleared on document switch by
 * `persistenceStore`.
 *
 * This is a **data store only** — no formatting, network, or Y.Doc imports
 * (live-collab value sync is a deferred phase). Keep it light and synchronous.
 * Fields are keyed by `name` (the `{{name}}` token); `setField` upserts.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Field, FieldLibrary } from '../types/Field';
import { isFieldLibrary } from '../types/Field';

interface FieldState {
  /** Fields keyed by name. */
  fields: Record<string, Field>;
  /** Display order of field names. */
  order: string[];
}

interface FieldActions {
  /** Insert or update a field by name (added to the order if new). */
  setField: (name: string, value: string) => void;
  /** Remove a field by name. */
  removeField: (name: string) => void;
  /** Get a field by name. */
  getField: (name: string) => Field | undefined;
  /** All fields in display order. */
  listFields: () => Field[];
  /** Reset to an empty library (document switch / new document). */
  clear: () => void;
  /** Load a serialized library, defensively normalizing malformed input. */
  loadFields: (data: FieldLibrary) => void;
  /** Serialize for persistence into `DiagramDocument.fields`. */
  serialize: () => FieldLibrary;
}

export const useFieldStore = create<FieldState & FieldActions>()(
  immer((set, get) => ({
    fields: {},
    order: [],

    setField: (name: string, value: string) => {
      const key = name.trim();
      if (!key) return; // a field must have a name (the `{{name}}` token)
      set((draft) => {
        if (!draft.fields[key]) {
          draft.order.push(key);
        }
        draft.fields[key] = { name: key, value };
      });
    },

    removeField: (name: string) => {
      set((draft) => {
        if (!draft.fields[name]) return;
        delete draft.fields[name];
        const index = draft.order.indexOf(name);
        if (index !== -1) {
          draft.order.splice(index, 1);
        }
      });
    },

    getField: (name: string) => {
      return get().fields[name];
    },

    listFields: () => {
      const state = get();
      return state.order
        .map((name) => state.fields[name])
        .filter((field): field is Field => field !== undefined);
    },

    clear: () => {
      set((draft) => {
        draft.fields = {};
        draft.order = [];
      });
    },

    loadFields: (data: FieldLibrary) => {
      set((draft) => {
        if (!isFieldLibrary(data)) {
          // Malformed input degrades to an empty library — never throw.
          draft.fields = {};
          draft.order = [];
          return;
        }
        // Drop order entries with no backing field, and append any fields
        // missing from the order, so the two collections stay consistent after
        // an imperfect import.
        const fields = data.fields;
        const order = data.order.filter((name) => fields[name] !== undefined);
        for (const name of Object.keys(fields)) {
          if (!order.includes(name)) {
            order.push(name);
          }
        }
        draft.fields = fields;
        draft.order = order;
      });
    },

    serialize: () => {
      const state = get();
      return {
        fields: state.fields,
        order: state.order,
      };
    },
  }))
);
