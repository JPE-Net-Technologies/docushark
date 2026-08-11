/**
 * Settings → Appearance — the consolidated home for visual/UX configuration.
 *
 * Built on the shared tile system (`../tiles/Tile`), so this panel and the
 * layout menu read as one vocabulary (JP-253). The tile mosaic also let the
 * thirteen one-and-two-row groups this panel used to carry collapse into five
 * a reader can scan: Theme, Writing, Interface, Layout, Reset. (Canvas held a
 * single control — grid opacity — and folded into Interface.)
 *
 * Every store binding, option set and piece of behaviour is unchanged from the
 * row-based version — this is presentation only.
 *
 * Help text lives INSIDE its tile via the `hint` prop, not in a tooltip and not
 * floating beside the mosaic. A tooltip is reachable only by hovering, which
 * rules it out on touch entirely, and text sitting outside a tile reads as
 * commentary on the group rather than on the control it belongs to.
 */

import {
  AppWindow,
  Contrast,
  Grid3x3,
  Maximize,
  Monitor,
  Moon,
  PanelsTopLeft,
  RotateCcw,
  Rows3,
  Smartphone,
  SpellCheck,
  SquareDashed,
  Sun,
  SwatchBook,
  Table,
  TextCursorInput,
  Type,
  Wand2,
  Zap,
} from 'lucide-react';
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
import { ColorField } from '../components/ColorField';
import {
  ActionTile,
  CustomTile,
  FillTile,
  SegmentedTile,
  TileGroup,
  ToggleTile,
} from '../tiles/Tile';
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
  { value: 'system' as const, label: 'System', title: 'Your browser / OS spellchecker' },
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
  const roundedTables = useUIPreferencesStore((s) => s.appearancePrefs.roundedTables);
  const setRoundedTables = useUIPreferencesStore((s) => s.setRoundedTables);
  const glass = useUIPreferencesStore((s) => s.appearancePrefs.glass);
  const setGlass = useUIPreferencesStore((s) => s.setGlass);
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

      {/* ---------------------------------------------------------------- */}
      <TileGroup title="Theme" icon={SwatchBook}>
        <SegmentedTile
          icon={Contrast}
          label="Base"
          ariaLabel="Theme base"
          value={themePreference}
          onValueChange={(v: ThemePreference) => setThemePreference(v)}
          options={THEME_OPTIONS}
          hint={`You're editing your ${activeBase} theme — switch base to customize the other independently.`}
        />

        <CustomTile
          wide
          icon={Wand2}
          label="Presets"
          value={activePresetId ? THEME_PRESETS.find((p) => p.id === activePresetId)?.label : 'Custom'}
          hint="Start from a preset, then fine-tune the colors below."
        >
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
        </CustomTile>

        {/* ColorField renders its own label, hint, value and contrast warning,
            and owns the picker popover — so the tile is a container only. */}
        {THEME_SLOTS.map(({ slot, label, hint }) => (
          <CustomTile key={slot} wide className="tile--field">
            <ColorField
              label={label}
              hint={hint}
              value={themeInputs[slot]}
              defaultSwatch={baseSwatch[slot]}
              onChange={(value) => setThemeInput(activeBase, slot, value)}
              {...(warnFor(slot) !== undefined ? { warning: warnFor(slot) as string } : {})}
            />
          </CustomTile>
        ))}

        <ActionTile
          icon={RotateCcw}
          label={`Reset ${activeBase} theme`}
          value="Back to base"
          disabled={Object.keys(themeInputs as ThemeInputs).length === 0}
          onClick={() => setThemeInputs(activeBase, {})}
        />
      </TileGroup>

      {/* ---------------------------------------------------------------- */}
      <TileGroup title="Writing" icon={Type}>
        <CustomTile
          wide
          icon={SquareDashed}
          label="Prose background"
          value={PROSE_BACKGROUNDS[proseBackground].label}
          hint="The backdrop behind the writing area. Presets follow your theme colors."
        >
          <div className="prose-bg-row">
            {(Object.keys(PROSE_BACKGROUNDS) as ProseBackground[]).map((id) => (
              <button
                key={id}
                type="button"
                className={`prose-bg-option${proseBackground === id ? ' is-active' : ''}`}
                onClick={() => setProseBackground(id)}
                aria-pressed={proseBackground === id}
                title={PROSE_BACKGROUNDS[id].label}
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
        </CustomTile>

        <SegmentedTile
          icon={TextCursorInput}
          label="Caret style"
          value={caretStyle}
          onValueChange={(v: CaretStyle) => setCaretStyle(v)}
          options={CARET_OPTIONS}
          hint="The text cursor shape in the writing editor."
        />

        <ToggleTile
          icon={Type}
          label="Smooth writing"
          checked={smoothCaret}
          onCheckedChange={setSmoothCaret}
          hint="Glides between positions as you type. Off automatically when motion is reduced."
        />

        <ToggleTile
          icon={Table}
          label="Rounded tables"
          checked={roundedTables}
          onCheckedChange={setRoundedTables}
          hint="Off gives square, grid-style tables."
        />

        <CustomTile wide className="tile--field">
          <ColorField
            label="Caret color"
            hint="Defaults to the theme text color; applies to the block / smooth caret."
            value={caretColor ?? undefined}
            defaultSwatch="#0a1525"
            onChange={(value) => setCaretColor(value ?? null)}
          />
        </CustomTile>

        <SegmentedTile
          icon={SpellCheck}
          label="Spellcheck"
          value={spellcheck}
          onValueChange={(v: SpellcheckMode) => setSpellcheckMode(v)}
          options={SPELLCHECK_OPTIONS}
          hint="Custom uses DocuShark's dictionary and “Add to dictionary”; System uses your browser or OS checker. Only one runs at a time."
        />
      </TileGroup>

      {/* ---------------------------------------------------------------- */}
      <TileGroup title="Interface" icon={Rows3}>
        <FillTile
          icon={Maximize}
          label="Interface size"
          value={uiScalePercent}
          onValueChange={(pct) => setUiScale(pct / 100)}
          min={Math.round(UI_SCALE_MIN * 100)}
          max={Math.round(UI_SCALE_MAX * 100)}
          step={5}
          hint="The canvas and your diagrams are not affected."
        />

        <FillTile
          icon={Grid3x3}
          label="Grid opacity"
          value={gridOpacity}
          onValueChange={setGridOpacity}
          min={0}
          max={100}
          step={5}
          hint="0 hides the grid entirely."
        />

        <SegmentedTile
          icon={Rows3}
          label="Density"
          ariaLabel="Spacing density"
          value={density}
          onValueChange={(v: Density) => setDensity(v)}
          options={DENSITY_OPTIONS}
          hint="Compact fits more on screen; Spacious gives larger, easier targets."
        />

        <SegmentedTile
          icon={Zap}
          label="Motion"
          ariaLabel="Interface animations"
          value={motion}
          onValueChange={(v: MotionPreference) => setMotion(v)}
          options={MOTION_OPTIONS}
          hint="System follows your device's accessibility setting."
        />

        <ToggleTile
          icon={Contrast}
          label="Glass chrome"
          checked={glass}
          onCheckedChange={setGlass}
          hint="Translucent, blurred panels. Off is flat and opaque — lighter to render."
        />

        <MobilePreviewTile />
        <TitleBarTile />
      </TileGroup>

      {/* Layout — the panel-arrangement editor. A full sub-panel of per-layout
          dock dropdowns rather than a control, so it keeps its own rows inside
          one tile-styled surface instead of being forced into the mosaic.
          Converting it is a follow-up alongside the other Settings tabs. */}
      <section className="tile-group">
        <div className="tile-group__head">
          <span className="tile-group__icon" aria-hidden="true">
            <PanelsTopLeft size={15} strokeWidth={1.5} />
          </span>
          <h4 className="tile-group__title">Layout</h4>
          <span className="tile-group__rule" aria-hidden="true" />
        </div>
        <div className="tile tile--embed">
          <LayoutSettings embedded />
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <TileGroup title="Reset" icon={RotateCcw}>
        <ActionTile
          danger
          icon={RotateCcw}
          label="Reset appearance"
          value="Back to defaults"
          onClick={handleReset}
          hint="Theme, motion, density, interface size and layout customization."
        />
      </TileGroup>
    </div>
  );
}

/**
 * Mobile preview opt-in/out (JP-332). A single switch over the two persisted
 * flags: turning it on accepts the preview and clears any opt-out; turning it
 * off forces the desktop layout. Only takes visible effect on a small touch
 * screen — `useMobileAdaptation` requires a coarse pointer — but it's shown
 * everywhere so an opted-out user (or a desktop user testing a narrow window)
 * has a discoverable, non-nagging way back in.
 */
function MobilePreviewTile() {
  const accepted = useUIPreferencesStore((s) => s.mobilePreviewAccepted);
  const forceDesktop = useUIPreferencesStore((s) => s.forceDesktopSite);
  const setMobilePreviewAccepted = useUIPreferencesStore((s) => s.setMobilePreviewAccepted);
  const setForceDesktopSite = useUIPreferencesStore((s) => s.setForceDesktopSite);

  const enabled = accepted && !forceDesktop;
  const handleToggle = (next: boolean) => {
    if (next) {
      setForceDesktopSite(false);
      setMobilePreviewAccepted(true);
    } else {
      setMobilePreviewAccepted(false);
      setForceDesktopSite(true);
    }
  };

  return (
    <ToggleTile
      icon={Smartphone}
      label="Mobile preview"
      checked={enabled}
      onCheckedChange={handleToggle}
      hint="Experimental. Only takes effect on a touch device with a small screen."
    />
  );
}

/**
 * DocuShark title bar opt-in. Gated to the desktop shell that owns a native
 * title bar — `windowControls.isSupported()` is false on the web app (and we
 * exclude macOS) — so the tile is absent there (JP-107).
 */
function TitleBarTile() {
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
    <ToggleTile
      icon={AppWindow}
      label="DocuShark title bar"
      checked={customChrome}
      onCheckedChange={handleToggle}
      hint="Replaces your system window title bar. The app restarts to apply."
    />
  );
}
