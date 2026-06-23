/**
 * Settings → Appearance — the consolidated home for visual/UX configuration.
 *
 * Sections: Theme builder (base + presets + Primary/CTA/Surface/Text + Surprise
 * me), Motion, Density, Interface size, Canvas, Layout (embedded), and Title bar
 * (desktop-only). Kept self-contained (no coupling to `SettingsModal` internals)
 * so it survives the planned settings-menu rework.
 */

import { Monitor, Moon, Sun, Wand2 } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore';
import { useThemeStore, type ThemePreference } from '../../store/themeStore';
import {
  useUIPreferencesStore,
  type Density,
  type CaretStyle,
  type SpellcheckMode,
  type ProseBackground,
  type ThemeBase,
  type ThemeColorSlot,
  type ThemeInputs,
  UI_SCALE_MIN,
  UI_SCALE_MAX,
} from '../../store/uiPreferencesStore';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useNotificationStore } from '../../store/notificationStore';
import type { MotionPreference } from '../../platform/adaptiveBudget';
import { windowControls } from '../../platform/window';
import { opener } from '../../platform/opener';
import { isMacOS } from '../../utils/platform';
import { contrastRatio } from '../../utils/color';
import {
  BASE_SWATCHES,
  PROSE_BACKGROUNDS,
  THEME_PRESETS,
  THEME_SLOTS,
  surpriseTheme,
} from '../appearance/themeEngine';
import { SegmentedControl } from '../components/SegmentedControl';
import { Slider } from '../components/Slider';
import { Switch } from '../components/Switch';
import { ColorField } from '../components/ColorField';
import { resetAppearance } from '../appearance/appearanceConfig';
import { LayoutSettings } from './LayoutSettings';
import './AppearanceSettings.css';

const THEME_OPTIONS = [
  { value: 'system' as const, label: 'System', icon: <Monitor size={15} />, title: 'Follow your device appearance' },
  { value: 'light' as const, label: 'Light', icon: <Sun size={15} />, title: 'Light theme' },
  { value: 'dark' as const, label: 'Dark', icon: <Moon size={15} />, title: 'Dark theme' },
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

const CARET_OPTIONS = [
  { value: 'bar' as const, label: 'Bar', title: 'Thin I-beam caret' },
  { value: 'block' as const, label: 'Block', title: 'Block caret over the character' },
];

const SPELLCHECK_OPTIONS = [
  { value: 'custom' as const, label: 'Custom', title: "DocuShark's dictionary + Add to dictionary" },
  { value: 'system' as const, label: 'System', title: "Your browser / OS spellchecker" },
  { value: 'off' as const, label: 'Off', title: 'No spellchecking' },
];

/** WCAG thresholds for the inline contrast warnings. */
const AA_TEXT = 4.5;
const UI_MIN = 3;

export function AppearanceSettings() {
  const themePreference = useThemeStore((s) => s.preference);
  const setThemePreference = useThemeStore((s) => s.setPreference);
  // The base being edited follows the resolved (active) theme.
  const activeBase = useThemeStore((s) => s.resolvedTheme) as ThemeBase;

  const themeInputs = useUIPreferencesStore((s) => s.appearancePrefs.themeInputs[activeBase]);
  const setThemeInput = useUIPreferencesStore((s) => s.setThemeInput);
  const setThemeInputs = useUIPreferencesStore((s) => s.setThemeInputs);

  const motion = useUIPreferencesStore((s) => s.appearancePrefs.motion);
  const setMotion = useUIPreferencesStore((s) => s.setMotion);
  const density = useUIPreferencesStore((s) => s.appearancePrefs.density);
  const setDensity = useUIPreferencesStore((s) => s.setDensity);
  const uiScale = useUIPreferencesStore((s) => s.appearancePrefs.uiScale);
  const setUiScale = useUIPreferencesStore((s) => s.setUiScale);
  const proseBackground = useUIPreferencesStore((s) => s.appearancePrefs.proseBackground);
  const setProseBackground = useUIPreferencesStore((s) => s.setProseBackground);
  const caretStyle = useUIPreferencesStore((s) => s.appearancePrefs.caretStyle);
  const setCaretStyle = useUIPreferencesStore((s) => s.setCaretStyle);
  const smoothCaret = useUIPreferencesStore((s) => s.appearancePrefs.smoothCaret);
  const setSmoothCaret = useUIPreferencesStore((s) => s.setSmoothCaret);
  const caretColor = useUIPreferencesStore((s) => s.appearancePrefs.caretColor);
  const setCaretColor = useUIPreferencesStore((s) => s.setCaretColor);
  const spellcheck = useUIPreferencesStore((s) => s.appearancePrefs.spellcheck);
  const setSpellcheckMode = useUIPreferencesStore((s) => s.setSpellcheckMode);
  const gridOpacity = useSettingsStore((s) => s.gridOpacity);
  const setGridOpacity = useSettingsStore((s) => s.setGridOpacity);

  const uiScalePercent = Math.round(uiScale * 100);
  const baseSwatch = BASE_SWATCHES[activeBase];

  // Resolved surface for contrast checks (override or base default).
  const resolvedSurface = themeInputs.surface ?? baseSwatch.surface;
  const warnFor = (slot: ThemeColorSlot): string | undefined => {
    const v = themeInputs[slot];
    if (!v) return undefined; // unset → engine derives safely
    if (slot === 'text' && contrastRatio(v, resolvedSurface) < AA_TEXT) return 'Low contrast';
    if (slot === 'primary' && contrastRatio(v, resolvedSurface) < UI_MIN) return 'Low contrast on this surface';
    return undefined;
  };

  const activePresetId = THEME_PRESETS.find(
    (p) => JSON.stringify(p[activeBase]) === JSON.stringify(themeInputs)
  )?.id;

  const handleReset = () => {
    if (window.confirm('Reset theme, motion, density, interface size, and layout customization to their defaults?')) {
      resetAppearance();
    }
  };

  return (
    <div className="appearance-settings">
      <h3 className="settings-section-title">Appearance</h3>

      {/* Theme builder */}
      <div className="settings-group">
        <h4 className="settings-group-title">Theme</h4>

        <div className="settings-row">
          <span className="settings-label">Base</span>
          <SegmentedControl
            ariaLabel="Theme base"
            value={themePreference}
            onValueChange={(v: ThemePreference) => setThemePreference(v)}
            options={THEME_OPTIONS}
          />
          <span className="settings-hint">
            Light or dark foundation. You're editing your <strong>{activeBase}</strong> theme;
            switch base to customize the other independently.
          </span>
        </div>

        <div className="settings-row">
          <span className="settings-label">Presets</span>
          <div className="theme-preset-row">
            {THEME_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`theme-preset${activePresetId === preset.id ? ' is-active' : ''}`}
                onClick={() => setThemeInputs(activeBase, preset[activeBase])}
              >
                <span
                  className="theme-preset__dot"
                  style={{ background: preset[activeBase].primary ?? baseSwatch.primary }}
                  aria-hidden="true"
                />
                {preset.label}
              </button>
            ))}
            <button
              type="button"
              className="theme-preset theme-preset--surprise"
              onClick={() => setThemeInputs(activeBase, surpriseTheme(activeBase))}
              title="Generate a random, legible theme"
            >
              <Wand2 size={14} aria-hidden="true" /> Surprise me
            </button>
          </div>
          <span className="settings-hint">Start from a preset, then fine-tune the colors below.</span>
        </div>

        <div className="theme-slots">
          {THEME_SLOTS.map(({ slot, label, hint }) => (
            <ColorField
              key={slot}
              label={label}
              hint={hint}
              value={themeInputs[slot]}
              defaultSwatch={baseSwatch[slot]}
              onChange={(value) => setThemeInput(activeBase, slot, value)}
              {...(warnFor(slot) !== undefined ? { warning: warnFor(slot) as string } : {})}
            />
          ))}
        </div>

        <div className="settings-row">
          <button
            type="button"
            className="theme-reset-base"
            disabled={Object.keys(themeInputs as ThemeInputs).length === 0}
            onClick={() => setThemeInputs(activeBase, {})}
          >
            Reset {activeBase} theme to default
          </button>
        </div>
      </div>

      {/* Prose background */}
      <div className="settings-group">
        <h4 className="settings-group-title">Prose background</h4>
        <div className="settings-row">
          <span className="settings-label">Editor backdrop</span>
          <div className="prose-bg-row">
            {(Object.keys(PROSE_BACKGROUNDS) as ProseBackground[]).map((id) => (
              <button
                key={id}
                type="button"
                className={`prose-bg-option${proseBackground === id ? ' is-active' : ''}`}
                onClick={() => setProseBackground(id)}
                aria-pressed={proseBackground === id}
              >
                <span
                  className="prose-bg-preview"
                  style={{ background: PROSE_BACKGROUNDS[id].value ?? 'var(--bg-primary)' }}
                  aria-hidden="true"
                />
                {PROSE_BACKGROUNDS[id].label}
              </button>
            ))}
          </div>
          <span className="settings-hint">
            The backdrop behind the writing area. Presets follow your theme colors.
          </span>
        </div>
      </div>

      {/* Caret */}
      <div className="settings-group">
        <h4 className="settings-group-title">Caret</h4>
        <div className="settings-row">
          <span className="settings-label">Style</span>
          <SegmentedControl
            ariaLabel="Caret style"
            value={caretStyle}
            onValueChange={(v: CaretStyle) => setCaretStyle(v)}
            options={CARET_OPTIONS}
          />
          <span className="settings-hint">
            The text cursor shape in the writing editor.
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-label">Smooth writing</span>
          <Switch
            ariaLabel="Smooth caret"
            checked={smoothCaret}
            onCheckedChange={setSmoothCaret}
          />
          <span className="settings-hint">
            Glide the caret between positions as you type instead of jumping.
            Automatically off when interface motion is reduced.
          </span>
        </div>
        <ColorField
          label="Color"
          hint="The writing caret's color. Defaults to the theme text color; applies to the block / smooth caret."
          value={caretColor ?? undefined}
          defaultSwatch="#0a1525"
          onChange={(value) => setCaretColor(value ?? null)}
        />
      </div>

      {/* Spelling */}
      <div className="settings-group">
        <h4 className="settings-group-title">Spelling</h4>
        <div className="settings-row">
          <span className="settings-label">Spellcheck</span>
          <SegmentedControl
            ariaLabel="Spellcheck"
            value={spellcheck}
            onValueChange={(v: SpellcheckMode) => setSpellcheckMode(v)}
            options={SPELLCHECK_OPTIONS}
          />
          <span className="settings-hint">
            <strong>Custom</strong> uses DocuShark's dictionary and “Add to dictionary”.
            <strong> System</strong> uses your browser/OS spellchecker.
            <strong> Off</strong> disables spellchecking. Only one runs at a time.
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

/**
 * DocuShark title bar opt-in. Gated to the desktop shell that owns a native
 * title bar — `windowControls.isSupported()` is false on the web app (and we
 * exclude macOS) — so the whole section is absent there (JP-107).
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
    try {
      usePersistenceStore.getState().saveDocument();
    } catch {
      // Best-effort flush; the user already confirmed the restart.
    }
    if (import.meta.env.DEV) {
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
