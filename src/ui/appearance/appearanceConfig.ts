/**
 * Appearance snapshot seam (Abstraction B) — a single read/write surface across
 * the two stores that own appearance state (theme light/dark base in `themeStore`,
 * custom-theme inputs + motion/density/scale in `uiPreferencesStore`). Designed
 * so the future "Workspaces" presets + shareable-config / export-import features
 * capture and apply a whole look in one call, without reaching into each store.
 */

import { useThemeStore, type ThemePreference } from '../../store/themeStore';
import {
  useUIPreferencesStore,
  type Density,
  type ProseBackground,
  type ThemeBuild,
} from '../../store/uiPreferencesStore';
import type { MotionPreference } from '../../platform/adaptiveBudget';

export interface AppearanceConfig {
  theme: ThemePreference;
  themeInputs: ThemeBuild;
  motion: MotionPreference;
  density: Density;
  uiScale: number;
  proseBackground: ProseBackground;
  roundedTables: boolean;
}

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  theme: 'system',
  themeInputs: { light: {}, dark: {} },
  motion: 'system',
  density: 'normal',
  uiScale: 1,
  proseBackground: 'default',
  roundedTables: true,
};

/** Capture the current appearance as a portable config object. */
export function getAppearanceSnapshot(): AppearanceConfig {
  const { themeInputs, motion, density, uiScale, proseBackground, roundedTables } =
    useUIPreferencesStore.getState().appearancePrefs;
  return {
    theme: useThemeStore.getState().preference,
    themeInputs,
    motion,
    density,
    uiScale,
    proseBackground,
    roundedTables,
  };
}

/** Apply a (partial) appearance config across both stores. */
export function applyAppearanceSnapshot(cfg: Partial<AppearanceConfig>): void {
  const ui = useUIPreferencesStore.getState();
  if (cfg.theme !== undefined) useThemeStore.getState().setPreference(cfg.theme);
  if (cfg.themeInputs !== undefined) {
    ui.setThemeInputs('light', cfg.themeInputs.light);
    ui.setThemeInputs('dark', cfg.themeInputs.dark);
  }
  if (cfg.motion !== undefined) ui.setMotion(cfg.motion);
  if (cfg.density !== undefined) ui.setDensity(cfg.density);
  if (cfg.uiScale !== undefined) ui.setUiScale(cfg.uiScale);
  if (cfg.proseBackground !== undefined) ui.setProseBackground(cfg.proseBackground);
  if (cfg.roundedTables !== undefined) ui.setRoundedTables(cfg.roundedTables);
}

/**
 * Reset every appearance choice to its default — theme, custom-theme inputs,
 * motion, density, UI scale, and the per-layout customization deltas.
 */
export function resetAppearance(): void {
  applyAppearanceSnapshot(DEFAULT_APPEARANCE);
  useUIPreferencesStore.getState().resetLayoutCustomization();
}
