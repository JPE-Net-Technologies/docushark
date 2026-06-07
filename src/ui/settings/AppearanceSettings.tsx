/**
 * Settings → Appearance — the consolidated home for visual/UX configuration.
 *
 * Sections: Theme, Canvas, Layout (the panel-arrangement editor, embedded), and
 * Window chrome (desktop-only). Accent / Motion / Density + UI-scale knobs land
 * in later slices of the Appearance epic; this panel is the structural backbone.
 *
 * Kept self-contained (no coupling to `SettingsModal` internals) so it survives
 * the planned settings-menu rework.
 */

import { Monitor, Moon, Sun } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore';
import { useThemeStore, type ThemePreference } from '../../store/themeStore';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useNotificationStore } from '../../store/notificationStore';
import { windowControls } from '../../platform/window';
import { opener } from '../../platform/opener';
import { isMacOS } from '../../utils/platform';
import { SegmentedControl } from '../components/SegmentedControl';
import { Switch } from '../components/Switch';
import { LayoutSettings } from './LayoutSettings';
import './AppearanceSettings.css';

const THEME_OPTIONS = [
  { value: 'system' as const, label: 'System', icon: <Monitor size={15} />, title: 'Follow your OS appearance' },
  { value: 'light' as const, label: 'Light', icon: <Sun size={15} />, title: 'Light theme' },
  { value: 'dark' as const, label: 'Dark', icon: <Moon size={15} />, title: 'Dark theme' },
];

export function AppearanceSettings() {
  const themePreference = useThemeStore((s) => s.preference);
  const setThemePreference = useThemeStore((s) => s.setPreference);
  const gridOpacity = useSettingsStore((s) => s.gridOpacity);
  const setGridOpacity = useSettingsStore((s) => s.setGridOpacity);

  return (
    <div className="appearance-settings">
      <h3 className="settings-section-title">Appearance</h3>

      {/* Theme */}
      <div className="settings-group">
        <h4 className="settings-group-title">Theme</h4>
        <div className="settings-row">
          <span className="settings-label">Color theme</span>
          <SegmentedControl
            ariaLabel="Color theme"
            value={themePreference}
            onValueChange={(v: ThemePreference) => setThemePreference(v)}
            options={THEME_OPTIONS}
          />
          <span className="settings-hint">
            Choose your preferred color theme. Your choice is remembered across sessions.
          </span>
        </div>
      </div>

      {/* Canvas */}
      <div className="settings-group">
        <h4 className="settings-group-title">Canvas</h4>
        <div className="settings-row">
          <label className="settings-label" htmlFor="grid-opacity">
            Grid Opacity
          </label>
          <div className="settings-slider-row">
            <input
              id="grid-opacity"
              type="range"
              className="styled-slider"
              min={0}
              max={100}
              value={gridOpacity}
              onChange={(e) => setGridOpacity(Number(e.target.value))}
            />
            <span className="settings-slider-value">{gridOpacity}%</span>
          </div>
          <span className="settings-hint">
            Adjust the visibility of the canvas grid (0 = hidden)
          </span>
        </div>
      </div>

      {/* Layout — the panel-arrangement editor, embedded as a section. */}
      <LayoutSettings embedded />

      {/* Window chrome — desktop-only; renders nothing on the PWA. */}
      <WindowChromeSection />
    </div>
  );
}

/**
 * Custom-window-chrome opt-in. Gated to the desktop shell that actually owns a
 * native title bar — `windowControls.isSupported()` is false on the PWA (and we
 * exclude macOS, whose traffic-light controls can't be credibly replaced), so
 * the whole section is absent on web (closes JP-107: the toggle no longer leaks
 * onto the PWA, where it had no effect).
 */
function WindowChromeSection() {
  const customChrome = useUIPreferencesStore((s) => s.layout.customChrome);
  const setCustomChrome = useUIPreferencesStore((s) => s.setCustomChrome);

  if (!windowControls.isSupported() || isMacOS()) return null;

  const handleToggle = (next: boolean) => {
    const verb = import.meta.env.DEV
      ? 'The flag will be saved (manual `tauri:dev` restart required)'
      : 'The app will restart';
    const confirmed = window.confirm(
      next
        ? `Use custom window chrome? ${verb} to apply.`
        : `Revert to system window decorations? ${verb} to apply.`
    );
    if (!confirmed) return;
    setCustomChrome(next);
    // Flush any pending auto-save so the restart path doesn't trip the
    // "unsaved changes" beforeunload prompt.
    try {
      usePersistenceStore.getState().saveDocument();
    } catch {
      // Best-effort flush; the user already confirmed the restart.
    }
    // Dev-mode caveat: `app.restart()` under `tauri dev` kills the cargo-spawned
    // binary without re-spawning, so persist the flag and tell the developer to
    // bounce `tauri:dev`. Production bundles restart cleanly.
    if (import.meta.env.DEV) {
      void opener.persistCustomChrome(next);
      useNotificationStore.getState().warning(
        'Custom chrome flag saved. In dev mode you must stop and restart `bun run tauri:dev` manually for it to take effect.',
        { duration: 10000 }
      );
    } else {
      void opener.applyCustomChrome(next);
    }
  };

  return (
    <div className="settings-group">
      <h4 className="settings-group-title">Window</h4>
      <div className="settings-row settings-row-switch">
        <label className="settings-switch-label" htmlFor="custom-chrome">
          <Switch
            id="custom-chrome"
            checked={customChrome}
            onCheckedChange={handleToggle}
            ariaLabel="Use custom window chrome"
          />
          <span className="settings-switch-text">Use custom window chrome</span>
        </label>
        <span className="settings-hint">
          Replace the native title bar with DocuShark's in-app window chrome.
          {import.meta.env.DEV
            ? ' In dev, restart tauri:dev to apply.'
            : ' The app restarts to apply.'}
        </span>
      </div>
    </div>
  );
}
