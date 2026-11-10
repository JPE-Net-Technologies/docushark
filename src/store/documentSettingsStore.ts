/**
 * documentSettingsStore - the active document's settings (DSK-246).
 *
 * Holds `DiagramDocument.settings` WHOLE, keys this build doesn't know
 * included, so a save never drops a setting a newer build wrote. Loaded and
 * cleared on document switch by `persistenceStore`, serialized into the
 * document on save, and mirrored per key to the collab `settings` map by
 * `useCollaborationSync`.
 */

import { create } from 'zustand';
import {
  normalizeDocumentSettings,
  type DocumentSettings,
  type SettingValue,
} from '../types/DocumentSettings';

interface DocumentSettingsState {
  /** Every setting the document holds, known to this build or not. */
  settings: DocumentSettings;
  /**
   * Which document the settings belong to: its id, `null` for a new document,
   * `undefined` before any document has loaded (see {@link settingsForSave}).
   */
  documentId: string | null | undefined;
}

interface DocumentSettingsActions {
  /** Set one setting; `undefined` removes it. The others keep their identity. */
  set: (key: string, value: SettingValue | undefined) => void;
  /** Load a document's settings on a document switch. Malformed input loads none. */
  load: (raw: unknown, documentId: string | null) => void;
  /** Adopt the collab document's settings, keeping `documentId`. */
  loadRemote: (raw: unknown) => void;
  /** No settings: a new document. */
  clear: () => void;
  /** For `DiagramDocument.settings`: `undefined` when there are none. */
  serialize: () => DocumentSettings | undefined;
}

export const useDocumentSettingsStore = create<DocumentSettingsState & DocumentSettingsActions>()(
  (set, get) => ({
    settings: {},
    documentId: undefined,

    set: (key, value) => {
      const { settings } = get();
      if (value === undefined) {
        if (!(key in settings)) return;
        const next = { ...settings };
        delete next[key];
        set({ settings: next });
        return;
      }
      set({ settings: { ...settings, [key]: value } });
    },

    load: (raw, documentId) => set({ settings: normalizeDocumentSettings(raw), documentId }),

    loadRemote: (raw) => set({ settings: normalizeDocumentSettings(raw) }),

    clear: () => set({ settings: {}, documentId: null }),

    serialize: () => {
      const { settings } = get();
      return Object.keys(settings).length > 0 ? { ...settings } : undefined;
    },
  }),
);

/**
 * The settings a save writes: the store's once a document has loaded into it.
 * Before then (a save racing the first load) the stored copy's, so that save
 * can't erase them.
 */
export function settingsForSave(stored: DocumentSettings | undefined): DocumentSettings | undefined {
  const state = useDocumentSettingsStore.getState();
  return state.documentId === undefined ? stored : state.serialize();
}
