/**
 * Color palette store for tracking recent and favorite colors.
 *
 * Persists to localStorage so colors are remembered across sessions.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Maximum number of recent colors to track.
 */
const MAX_RECENT_COLORS = 8;

/**
 * Color palette state.
 */
export interface ColorPaletteState {
  /** Recently used colors (most recent first) */
  recentColors: string[];
  /** Current custom color value */
  customColor: string;
}

/**
 * Color palette actions.
 */
export interface ColorPaletteActions {
  /** Add a color to recent colors (deduplicates and moves to front) */
  addRecentColor: (color: string) => void;
  /** Set the custom color value */
  setCustomColor: (color: string) => void;
  /** Clear all recent colors */
  clearRecentColors: () => void;
  /** Reset to initial state */
  reset: () => void;
}

/**
 * Initial state.
 */
const initialState: ColorPaletteState = {
  recentColors: [],
  customColor: '#4a90d9',
};

/**
 * Normalize a color to lowercase hex format.
 */
function normalizeColor(color: string): string {
  return color.toLowerCase().trim();
}

/**
 * Check if a color is a valid hex color.
 */
function isValidHexColor(color: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color);
}

/**
 * Color palette store.
 *
 * Tracks recently used colors and provides a custom color picker value.
 * All data is persisted to localStorage.
 *
 * Usage:
 * ```typescript
 * const { recentColors, addRecentColor, customColor, setCustomColor } = useColorPaletteStore();
 *
 * // When user selects a color
 * addRecentColor('#ff0000');
 *
 * // Custom color picker
 * setCustomColor('#abcdef');
 * ```
 */
export const useColorPaletteStore = create<ColorPaletteState & ColorPaletteActions>()(
  persist(
    (set, get) => ({
      // State
      ...initialState,

      // Actions
      addRecentColor: (color: string) => {
        // Skip empty, transparent, or invalid colors
        if (!color || color === 'transparent' || color === '') return;

        const normalized = normalizeColor(color);

        // Skip if not a valid hex color
        if (!isValidHexColor(normalized)) return;

        const { recentColors } = get();

        // Remove if already exists (will be added to front)
        const filtered = recentColors.filter(
          (c) => normalizeColor(c) !== normalized
        );

        // Add to front, limit to max
        const updated = [normalized, ...filtered].slice(0, MAX_RECENT_COLORS);

        set({ recentColors: updated });
      },

      setCustomColor: (color: string) => {
        set({ customColor: color });
      },

      clearRecentColors: () => {
        set({ recentColors: [] });
      },

      reset: () => {
        set(initialState);
      },
    }),
    {
      name: 'docushark-color-palette',
      partialize: (state) => ({
        recentColors: state.recentColors,
        customColor: state.customColor,
      }),
    }
  )
);
