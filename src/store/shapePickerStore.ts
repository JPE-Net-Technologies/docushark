/**
 * Tiny persisted store backing the ShapePicker's "Recent" row — the ids of the
 * most recently inserted shapes (built-in types or `custom-shape:<id>`), newest
 * first, capped. Deliberately isolated from the versioned `uiPreferencesStore`
 * so a cosmetic convenience can't put the layout-migration surface at risk; it
 * has its own localStorage key and no migration chain.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/** How many recent entries to remember. */
export const MAX_RECENT_SHAPES = 8;

/**
 * Pure reducer: move `id` to the front of `recents`, dedupe, and cap. Exported
 * for unit testing the ordering/cap behavior without the store/persistence.
 */
export function withRecent(recents: string[], id: string, max = MAX_RECENT_SHAPES): string[] {
  return [id, ...recents.filter((r) => r !== id)].slice(0, max);
}

export interface ShapePickerState {
  /** Recently inserted entry ids, newest first. */
  recents: string[];
  /** Record an insertion, promoting the id to the front. */
  recordUse: (id: string) => void;
  /** Clear the recent list. */
  clearRecents: () => void;
}

export const useShapePickerStore = create<ShapePickerState>()(
  persist(
    (set) => ({
      recents: [],
      recordUse: (id) => set((state) => ({ recents: withRecent(state.recents, id) })),
      clearRecents: () => set({ recents: [] }),
    }),
    {
      name: 'docushark-shape-picker',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ recents: state.recents }),
    }
  )
);
