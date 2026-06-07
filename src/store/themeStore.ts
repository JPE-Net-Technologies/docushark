import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Theme preference options.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * Resolved theme (always light or dark).
 */
export type ResolvedTheme = 'light' | 'dark';

/**
 * Theme colors for the canvas renderer.
 */
export interface ThemeColors {
  backgroundColor: string;
  gridColor: string;
  majorGridColor: string;
  originColor: string;
  selectionColor: string;
  handleFillColor: string;
  handleStrokeColor: string;
}

/**
 * Light theme colors.
 */
const LIGHT_COLORS: ThemeColors = {
  backgroundColor: '#ffffff',
  gridColor: '#e0e0e0',
  majorGridColor: '#c0c0c0',
  originColor: '#808080',
  selectionColor: '#2196f3',
  handleFillColor: '#ffffff',
  handleStrokeColor: '#2196f3',
};

/**
 * Dark theme colors.
 */
const DARK_COLORS: ThemeColors = {
  backgroundColor: '#1e1e1e',
  gridColor: '#2d2d2d',
  majorGridColor: '#3d3d3d',
  originColor: '#505050',
  selectionColor: '#0078d4',
  handleFillColor: '#2d2d2d',
  handleStrokeColor: '#0078d4',
};

/**
 * Theme store state.
 */
export interface ThemeState {
  /** User preference: 'light', 'dark', or 'system' */
  preference: ThemePreference;
  /** Resolved theme after applying system preference */
  resolvedTheme: ResolvedTheme;
  /** Canvas renderer colors for current theme */
  colors: ThemeColors;
}

/**
 * Theme store actions.
 */
export interface ThemeActions {
  /** Set theme preference */
  setPreference: (preference: ThemePreference) => void;
  /** Update resolved theme based on system preference */
  updateFromSystem: () => void;
  /** Get the opposite theme (for toggle) */
  getOppositeTheme: () => ResolvedTheme;
  /** Toggle between light and dark */
  toggle: () => void;
}

/**
 * Detect system color scheme preference.
 */
function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Resolve theme based on preference and system settings.
 */
function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') {
    return getSystemTheme();
  }
  return preference;
}

/**
 * Get colors for a resolved theme.
 */
function getColorsForTheme(theme: ResolvedTheme): ThemeColors {
  return theme === 'dark' ? DARK_COLORS : LIGHT_COLORS;
}

/**
 * Fallbacks for the PWA `theme-color` meta — kept in sync with `--bg-primary`
 * in `index.css` (light warm-paper surface / dark navy surface). Used only when
 * the computed token can't be read yet (e.g. before stylesheet application).
 */
const THEME_COLOR_FALLBACK: Record<ResolvedTheme, string> = {
  light: '#f9f6ee',
  dark: '#0e1c30',
};

/**
 * Update (or create) the `<meta name="theme-color">` element so an installed
 * PWA's mobile browser/status-bar chrome matches the active theme. Prefers the
 * live `--bg-primary` token so it tracks the brand palette without drift.
 */
function applyThemeColorMeta(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  const computed = getComputedStyle(document.documentElement)
    .getPropertyValue('--bg-primary')
    .trim();
  meta.content = computed || THEME_COLOR_FALLBACK[theme];
}

/**
 * Apply theme to document: sets the `data-theme` attribute (which drives every
 * semantic token + `color-scheme` in `index.css`) and the PWA theme-color meta.
 */
function applyThemeToDocument(theme: ResolvedTheme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
    applyThemeColorMeta(theme);
  }
}

/**
 * Initial theme state.
 */
const initialPreference: ThemePreference = 'system';
const initialResolved = resolveTheme(initialPreference);

/**
 * Theme store for managing light/dark mode.
 *
 * Supports:
 * - Explicit light/dark preference
 * - System preference detection
 * - Automatic updates when system preference changes
 *
 * Usage:
 * ```typescript
 * const { resolvedTheme, setPreference, toggle } = useThemeStore();
 *
 * // Toggle theme
 * toggle();
 *
 * // Set explicit preference
 * setPreference('dark');
 *
 * // Follow system
 * setPreference('system');
 * ```
 */
export const useThemeStore = create<ThemeState & ThemeActions>()(
  persist(
    (set, get) => ({
      // State
      preference: initialPreference,
      resolvedTheme: initialResolved,
      colors: getColorsForTheme(initialResolved),

      // Actions
      setPreference: (preference: ThemePreference) => {
        const resolvedTheme = resolveTheme(preference);
        const colors = getColorsForTheme(resolvedTheme);
        applyThemeToDocument(resolvedTheme);
        set({ preference, resolvedTheme, colors });
      },

      updateFromSystem: () => {
        const { preference } = get();
        if (preference === 'system') {
          const resolvedTheme = getSystemTheme();
          const colors = getColorsForTheme(resolvedTheme);
          applyThemeToDocument(resolvedTheme);
          set({ resolvedTheme, colors });
        }
      },

      getOppositeTheme: (): ResolvedTheme => {
        return get().resolvedTheme === 'light' ? 'dark' : 'light';
      },

      toggle: () => {
        const opposite = get().getOppositeTheme();
        get().setPreference(opposite);
      },
    }),
    {
      name: 'docushark-theme',
      // Only the user's choice is durable; `resolvedTheme`/`colors` are derived.
      partialize: (state) => ({ preference: state.preference }),
      // localStorage hydrates synchronously during `create`, so recompute the
      // derived fields from the persisted preference here — that way the
      // module-load apply below reads the correct theme and there's no FOUC.
      merge: (persisted, current) => {
        const preference =
          (persisted as { preference?: ThemePreference } | undefined)?.preference ??
          current.preference;
        const resolvedTheme = resolveTheme(preference);
        return {
          ...current,
          preference,
          resolvedTheme,
          colors: getColorsForTheme(resolvedTheme),
        };
      },
    }
  )
);

// Apply the (already-hydrated) theme on load — reads the persisted preference,
// not the pre-hydration default, so a saved Dark choice paints dark immediately.
if (typeof document !== 'undefined') {
  applyThemeToDocument(useThemeStore.getState().resolvedTheme);
}

// Listen for system theme changes
if (typeof window !== 'undefined') {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', () => {
    useThemeStore.getState().updateFromSystem();
  });
}
