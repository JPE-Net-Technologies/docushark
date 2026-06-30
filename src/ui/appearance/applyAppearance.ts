/**
 * Appearance applier (Abstraction A) — the single place that mirrors appearance
 * preferences onto the document. Runs at module load via vanilla
 * `store.subscribe` (NOT a React effect), so it applies the hydrated values
 * before first paint (localStorage hydrates synchronously on store creation) —
 * no flash — and keeps tracking changes from anywhere, inside or outside React.
 *
 * Theme colors → resolved from the active base's custom inputs and written as
 *   inline `--color-*`/`--bg-*`/`--text-*` overrides (which beat the stylesheet
 *   base in index.css). The full controlled-token set is iterated every apply:
 *   set for overridden tokens, removed otherwise — so a Light customization can
 *   never bleed onto Dark, and clearing a slot reverts cleanly to the base.
 * Density → `data-density` root attribute.
 * UI size → `--ui-scale` root var (rem root font-size).
 * Motion → handed to `adaptiveBudget`, the sole authority over `data-reduced-motion`.
 *
 * Theme colors + density + UI size are chrome-only by construction (they ride
 * the CSS token system); the canvas is flex/px-sized and maps input through its
 * own Camera, so it is never affected.
 */

import { useUIPreferencesStore, type AppearancePrefs } from '../../store/uiPreferencesStore';
import { useThemeStore } from '../../store/themeStore';
import { setMotionPreference } from '../../platform/adaptiveBudget';
import { PROSE_BACKGROUNDS, resolveThemeOverrides, THEME_CONTROLLED_TOKENS } from './themeEngine';

/** Apply the resolved custom-theme overrides for the *active* base. */
function applyThemeColors(prefs: AppearancePrefs): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const base = useThemeStore.getState().resolvedTheme; // 'light' | 'dark'
  const overrides = resolveThemeOverrides(base, prefs.themeInputs[base] ?? {});
  for (const token of THEME_CONTROLLED_TOKENS) {
    const value = overrides[token];
    if (value != null) {
      root.style.setProperty(token, value);
    } else {
      root.style.removeProperty(token);
    }
  }
}

/** Apply the non-color appearance prefs (density, UI scale, motion). */
function applyNonColor(prefs: AppearancePrefs): void {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset['density'] = prefs.density;
    root.style.setProperty('--ui-scale', String(prefs.uiScale));
    // Prose editor background: set the override, or remove it so the panel keeps
    // its built-in per-base behavior (the `default` preset).
    const prose = PROSE_BACKGROUNDS[prefs.proseBackground]?.value ?? null;
    if (prose) {
      root.style.setProperty('--prose-bg', prose);
    } else {
      root.style.removeProperty('--prose-bg');
    }
    // Rounded prose tables (opt-out). The table CSS keys off this attribute;
    // only the "false" (squared) case needs an override (JP-416).
    root.dataset['roundedTables'] = String(prefs.roundedTables);
  }
  setMotionPreference(prefs.motion);
}

function applyAll(prefs: AppearancePrefs): void {
  applyNonColor(prefs);
  applyThemeColors(prefs);
}

// Apply the already-hydrated preferences immediately, before first paint.
let applied = useUIPreferencesStore.getState().appearancePrefs;
applyAll(applied);

// Re-apply only when the appearance slice actually changes (the setters produce
// a new object reference), so unrelated UI-pref updates don't churn.
useUIPreferencesStore.subscribe((state) => {
  if (state.appearancePrefs !== applied) {
    applied = state.appearancePrefs;
    applyAll(applied);
  }
});

// Re-resolve theme colors when the base flips (explicit Light/Dark or a `system`
// OS change) — the active base's overrides differ.
let appliedBase = useThemeStore.getState().resolvedTheme;
useThemeStore.subscribe((state) => {
  if (state.resolvedTheme !== appliedBase) {
    appliedBase = state.resolvedTheme;
    applyThemeColors(applied);
  }
});
