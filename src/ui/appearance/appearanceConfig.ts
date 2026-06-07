/**
 * Appearance snapshot seam (Abstraction B) — a single read/write surface across
 * the two stores that own appearance state (theme preference in `themeStore`,
 * accent + motion in `uiPreferencesStore`). Designed now so the future
 * "Workspaces" presets + shareable-config features capture/apply a whole look
 * in one call, without reaching into each store. Not yet wired to UI beyond the
 * "Reset appearance" action.
 */

import { useThemeStore, type ThemePreference } from '../../store/themeStore';
import { useUIPreferencesStore, type AccentColor } from '../../store/uiPreferencesStore';
import type { MotionPreference } from '../../platform/adaptiveBudget';

export interface AppearanceConfig {
  theme: ThemePreference;
  accent: AccentColor;
  motion: MotionPreference;
}

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  theme: 'system',
  accent: 'default',
  motion: 'system',
};

/** Capture the current appearance as a portable config object. */
export function getAppearanceSnapshot(): AppearanceConfig {
  const { accent, motion } = useUIPreferencesStore.getState().appearancePrefs;
  return { theme: useThemeStore.getState().preference, accent, motion };
}

/** Apply a (partial) appearance config across both stores. */
export function applyAppearanceSnapshot(cfg: Partial<AppearanceConfig>): void {
  if (cfg.theme !== undefined) useThemeStore.getState().setPreference(cfg.theme);
  if (cfg.accent !== undefined) useUIPreferencesStore.getState().setAccent(cfg.accent);
  if (cfg.motion !== undefined) useUIPreferencesStore.getState().setMotion(cfg.motion);
}

/**
 * Reset every appearance choice to its default — theme, accent, motion, and the
 * per-layout customization deltas.
 */
export function resetAppearance(): void {
  applyAppearanceSnapshot(DEFAULT_APPEARANCE);
  useUIPreferencesStore.getState().resetLayoutCustomization();
}
