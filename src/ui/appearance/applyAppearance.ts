/**
 * Appearance applier (Abstraction A) — the single place that mirrors appearance
 * preferences onto the document. Runs at module load via a vanilla
 * `store.subscribe` (NOT a React effect), so it applies the hydrated values
 * before first paint (localStorage hydrates synchronously on store creation) —
 * no flash — and keeps tracking changes from anywhere, inside or outside React.
 *
 * Accent  → `data-accent` root attribute (CSS swaps `--color-primary*`).
 * Density → `data-density` root attribute (CSS scales `--density-mult`).
 * UI size → `--ui-scale` root var (CSS scales the rem root font-size).
 * Motion  → handed to `adaptiveBudget`, the sole authority over the
 *           `data-reduced-motion` attribute.
 *
 * Density + UI size are chrome-only by construction: they ride the rem token
 * system, while the canvas is flex/px-sized and maps coordinates through its
 * own Camera — so it is never affected.
 *
 * (Theme is applied by `themeStore` itself; this module owns the rest.)
 */

import { useUIPreferencesStore, type AppearancePrefs } from '../../store/uiPreferencesStore';
import { setMotionPreference } from '../../platform/adaptiveBudget';

function applyAppearance(prefs: AppearancePrefs): void {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset['accent'] = prefs.accent;
    root.dataset['density'] = prefs.density;
    root.style.setProperty('--ui-scale', String(prefs.uiScale));
  }
  setMotionPreference(prefs.motion);
}

// Apply the already-hydrated preferences immediately.
let applied = useUIPreferencesStore.getState().appearancePrefs;
applyAppearance(applied);

// Re-apply only when the appearance slice actually changes (the setters produce
// a new object reference), so unrelated UI-pref updates don't churn.
useUIPreferencesStore.subscribe((state) => {
  if (state.appearancePrefs !== applied) {
    applied = state.appearancePrefs;
    applyAppearance(applied);
  }
});
