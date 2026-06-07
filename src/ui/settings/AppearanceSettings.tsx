/**
 * Settings → Appearance — the consolidated home for visual/UX configuration.
 *
 * Sections: Theme, Accent color, Motion, Canvas, Layout (the panel-arrangement
 * editor, embedded), and Title bar (desktop-only). Density + UI-scale land in a
 * later slice. Kept self-contained (no coupling to `SettingsModal` internals)
 * so it survives the planned settings-menu rework.
 */

import type { CSSProperties } from 'react';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore';
import { useThemeStore, type ThemePreference } from '../../store/themeStore';
import {
  useUIPreferencesStore,
  type AccentColor,
  type Density,
  UI_SCALE_MIN,
  UI_SCALE_MAX,
} from '../../store/uiPreferencesStore';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useNotificationStore } from '../../store/notificationStore';
import type { MotionPreference } from '../../platform/adaptiveBudget';
import { windowControls } from '../../platform/window';
import { opener } from '../../platform/opener';
import { isMacOS } from '../../utils/platform';
import { SegmentedControl } from '../components/SegmentedControl';
import { Slider } from '../components/Slider';
import { Switch } from '../components/Switch';
import { resetAppearance } from '../appearance/appearanceConfig';
import { LayoutSettings } from './LayoutSettings';
import './AppearanceSettings.css';

const THEME_OPTIONS = [
  { value: 'system' as const, label: 'System', icon: <Monitor size={15} />, title: 'Follow your device appearance' },
  { value: 'light' as const, label: 'Light', icon: <Sun size={15} />, title: 'Light theme' },
  { value: 'dark' as const, label: 'Dark', icon: <Moon size={15} />, title: 'Dark theme' },
];

// Representative swatch colors (the light-theme hue). 'default' shows the brand
// navy and adds no override — the theme keeps its own accent (navy / gold).
const ACCENT_OPTIONS: ReadonlyArray<{ value: AccentColor; label: string; swatch: string }> = [
  { value: 'default', label: 'Default', swatch: '#1f3354' },
  { value: 'teal', label: 'Teal', swatch: '#0f766e' },
  { value: 'violet', label: 'Violet', swatch: '#6d28d9' },
  { value: 'amber', label: 'Amber', swatch: '#b45309' },
  { value: 'rose', label: 'Rose', swatch: '#be123c' },
];

const MOTION_OPTIONS = [
  { value: 'system' as const, label: 'System', title: 'Follow your device accessibility setting' },
  { value: 'reduced' as const, label: 'Reduced', title: 'Minimize interface animations' },
  { value: 'full' as const, label: 'Full', title: 'Always show interface animations' },
];

const DENSITY_OPTIONS = [
  { value: 'compact' as const, label: 'Compact', title: 'Tighter spacing — fit more on screen' },
  { value: 'normal' as const, label: 'Normal', title: 'Default spacing' },
  { value: 'spacious' as const, label: 'Spacious', title: 'Roomier spacing and larger targets' },
];

export function AppearanceSettings() {
  const themePreference = useThemeStore((s) => s.preference);
  const setThemePreference = useThemeStore((s) => s.setPreference);
  const accent = useUIPreferencesStore((s) => s.appearancePrefs.accent);
  const setAccent = useUIPreferencesStore((s) => s.setAccent);
  const motion = useUIPreferencesStore((s) => s.appearancePrefs.motion);
  const setMotion = useUIPreferencesStore((s) => s.setMotion);
  const density = useUIPreferencesStore((s) => s.appearancePrefs.density);
  const setDensity = useUIPreferencesStore((s) => s.setDensity);
  const uiScale = useUIPreferencesStore((s) => s.appearancePrefs.uiScale);
  const setUiScale = useUIPreferencesStore((s) => s.setUiScale);
  const gridOpacity = useSettingsStore((s) => s.gridOpacity);
  const setGridOpacity = useSettingsStore((s) => s.setGridOpacity);

  const uiScalePercent = Math.round(uiScale * 100);

  const handleReset = () => {
    if (window.confirm('Reset theme, accent color, motion, and layout customization to their defaults?')) {
      resetAppearance();
    }
  };

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

      {/* Accent color */}
      <div className="settings-group">
        <h4 className="settings-group-title">Accent color</h4>
        <div className="settings-row">
          <span className="settings-label">Accent</span>
          <AccentPicker value={accent} onValueChange={setAccent} />
          <span className="settings-hint">
            Tints buttons, links, highlights, and selected controls across the app.
          </span>
        </div>
      </div>

      {/* Motion */}
      <div className="settings-group">
        <h4 className="settings-group-title">Motion</h4>
        <div className="settings-row">
          <span className="settings-label">Interface animations</span>
          <SegmentedControl
            ariaLabel="Interface animations"
            value={motion}
            onValueChange={(v: MotionPreference) => setMotion(v)}
            options={MOTION_OPTIONS}
          />
          <span className="settings-hint">
            Reduce or turn off interface animations. "System" follows your device's
            accessibility setting.
          </span>
        </div>
      </div>

      {/* Density */}
      <div className="settings-group">
        <h4 className="settings-group-title">Density</h4>
        <div className="settings-row">
          <span className="settings-label">Spacing</span>
          <SegmentedControl
            ariaLabel="Spacing density"
            value={density}
            onValueChange={(v: Density) => setDensity(v)}
            options={DENSITY_OPTIONS}
          />
          <span className="settings-hint">
            Tighten or loosen spacing throughout the app. Compact fits more on screen;
            Spacious gives larger, easier targets.
          </span>
        </div>
      </div>

      {/* Interface size */}
      <div className="settings-group">
        <h4 className="settings-group-title">Interface size</h4>
        <div className="settings-row">
          <label className="settings-label" htmlFor="ui-scale">
            Size
          </label>
          <div className="settings-slider-row">
            <Slider
              ariaLabel="Interface size"
              value={uiScalePercent}
              onValueChange={(pct) => setUiScale(pct / 100)}
              min={Math.round(UI_SCALE_MIN * 100)}
              max={Math.round(UI_SCALE_MAX * 100)}
              step={5}
            />
            <span className="settings-slider-value">{uiScalePercent}%</span>
          </div>
          <span className="settings-hint">
            Scale the whole interface up or down. The canvas and your diagrams are
            not affected.
          </span>
        </div>
      </div>

      {/* Canvas */}
      <div className="settings-group">
        <h4 className="settings-group-title">Canvas</h4>
        <div className="settings-row">
          <label className="settings-label" htmlFor="grid-opacity">
            Grid opacity
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
            Adjust how visible the canvas grid is (0 = hidden).
          </span>
        </div>
      </div>

      {/* Layout — the panel-arrangement editor, embedded as a section. */}
      <LayoutSettings embedded />

      {/* Title bar — desktop-only; renders nothing on the web app. */}
      <TitleBarSection />

      {/* Reset */}
      <div className="settings-group">
        <h4 className="settings-group-title">Reset</h4>
        <button type="button" className="settings-reset-btn" onClick={handleReset}>
          Reset appearance to defaults
        </button>
      </div>
    </div>
  );
}

function AccentPicker({
  value,
  onValueChange,
}: {
  value: AccentColor;
  onValueChange: (value: AccentColor) => void;
}) {
  return (
    <RadioGroup.Root
      className="accent-picker"
      value={value}
      onValueChange={(v) => onValueChange(v as AccentColor)}
      aria-label="Accent color"
      orientation="horizontal"
      loop
    >
      {ACCENT_OPTIONS.map((opt) => (
        <RadioGroup.Item
          key={opt.value}
          className="accent-picker__swatch"
          value={opt.value}
          aria-label={opt.label}
          title={opt.label}
          style={{ '--swatch': opt.swatch } as CSSProperties}
        >
          <Check className="accent-picker__check" size={14} strokeWidth={3} aria-hidden="true" />
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

/**
 * DocuShark title bar opt-in. Gated to the desktop shell that actually owns a
 * native title bar — `windowControls.isSupported()` is false on the web app
 * (and we exclude macOS, whose window controls can't be credibly replaced) — so
 * the whole section is absent there (JP-107: the option no longer appears where
 * it has no effect).
 */
function TitleBarSection() {
  const customChrome = useUIPreferencesStore((s) => s.layout.customChrome);
  const setCustomChrome = useUIPreferencesStore((s) => s.setCustomChrome);

  if (!windowControls.isSupported() || isMacOS()) return null;

  const handleToggle = (next: boolean) => {
    const confirmed = window.confirm(
      next
        ? "Use DocuShark's title bar? The app will restart to apply."
        : "Switch back to your system's title bar? The app will restart to apply."
    );
    if (!confirmed) return;
    setCustomChrome(next);
    // Flush any pending auto-save so the restart doesn't trip the unsaved-changes prompt.
    try {
      usePersistenceStore.getState().saveDocument();
    } catch {
      // Best-effort flush; the user already confirmed the restart.
    }
    if (import.meta.env.DEV) {
      // Under `tauri dev` the app can't relaunch itself, so persist the flag and
      // let the developer relaunch. (Dev-only path; customers get the restart.)
      void opener.persistCustomChrome(next);
      useNotificationStore.getState().info('Title bar preference saved — restart the app to see it.', {
        duration: 6000,
      });
    } else {
      void opener.applyCustomChrome(next);
    }
  };

  return (
    <div className="settings-group">
      <h4 className="settings-group-title">Title bar</h4>
      <div className="settings-row settings-row-switch">
        <label className="settings-switch-label" htmlFor="docushark-title-bar">
          <Switch
            id="docushark-title-bar"
            checked={customChrome}
            onCheckedChange={handleToggle}
            ariaLabel="Use DocuShark's title bar"
          />
          <span className="settings-switch-text">Use DocuShark's title bar</span>
        </label>
        <span className="settings-hint">
          Replace your operating system's window title bar with DocuShark's own for a
          more unified look. The app restarts to apply.
        </span>
      </div>
    </div>
  );
}
