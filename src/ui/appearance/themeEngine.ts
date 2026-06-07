/**
 * Theme engine — pure derivation from a sparse set of user color inputs to the
 * full set of semantic token *overrides* (JP-58).
 *
 * Bulletproof-by-construction: the complete light/dark token sets live in
 * `index.css`. This engine only produces overrides for the slots the user set;
 * everything else falls through to that base, so no token can ever be missing.
 * `resolveThemeOverrides(base, {})` returns `{}` → the app looks exactly as it
 * does with no customization.
 *
 * Coverage is enforced by tests: `THEME_CONTROLLED_TOKENS` must be a subset of
 * the tokens defined in `index.css` (drift guard), and every set slot must
 * resolve every relative it owns to a parseable color (completeness).
 */

import {
  contrastRatio,
  darken,
  hslToRgb,
  lighten,
  mix,
  rgbToHex,
  withAlpha,
} from '../../utils/color';
import type {
  ProseBackground,
  ThemeBase,
  ThemeColorSlot,
  ThemeInputs,
} from '../../store/uiPreferencesStore';

/**
 * Every semantic token the engine may override. Order is irrelevant; the
 * applier iterates this set and set/removes each so reverting is total.
 */
export const THEME_CONTROLLED_TOKENS = [
  '--color-primary',
  '--color-primary-dark',
  '--color-primary-light',
  '--color-primary-alpha',
  '--color-on-primary',
  '--color-cta',
  '--color-cta-hover',
  '--color-cta-text',
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--bg-hover',
  '--bg-active',
  '--border-color',
  '--border-color-light',
  '--border-color-input',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--text-faint',
] as const;

export type ControlledToken = (typeof THEME_CONTROLLED_TOKENS)[number];

/** Brand ink/paper anchors used for contrast picks + text fallbacks. */
export const THEME_INK = '#0a1525';
export const THEME_PAPER = '#f6f4ec';
/** Default base surfaces (match index.css) — fallback for text-toward-surface mixing. */
const BASE_SURFACE: Record<ThemeBase, string> = { light: '#f9f6ee', dark: '#0e1c30' };

/** Pick ink or paper for the most readable text/icon on a filled color. */
export function onColor(fill: string): string {
  return contrastRatio(THEME_PAPER, fill) >= contrastRatio(THEME_INK, fill) ? THEME_PAPER : THEME_INK;
}

/**
 * Resolve the token overrides for one base from the user's sparse inputs.
 * Only set slots contribute; each set slot writes its whole token family.
 */
export function resolveThemeOverrides(
  base: ThemeBase,
  inputs: ThemeInputs
): Partial<Record<ControlledToken, string>> {
  const out: Partial<Record<ControlledToken, string>> = {};
  const { primary, cta, surface, text } = inputs;

  // Resolve text first (surface tints + borders key off it). When the user set a
  // surface but no text, derive a readable text color from the surface.
  const resolvedText = text ?? (surface ? onColor(surface) : undefined);

  if (primary) {
    out['--color-primary'] = primary;
    out['--color-primary-dark'] = darken(primary, 10);
    out['--color-primary-light'] = withAlpha(primary, base === 'dark' ? 0.14 : 0.12);
    out['--color-primary-alpha'] = withAlpha(primary, 0.3);
    out['--color-on-primary'] = onColor(primary);
  }

  if (cta) {
    out['--color-cta'] = cta;
    out['--color-cta-hover'] = darken(cta, 10);
    out['--color-cta-text'] = onColor(cta);
  }

  if (surface) {
    const tint = resolvedText ?? (base === 'dark' ? THEME_PAPER : THEME_INK);
    out['--bg-primary'] = surface;
    out['--bg-secondary'] = base === 'dark' ? darken(surface, 4) : darken(surface, 2);
    out['--bg-tertiary'] = base === 'dark' ? lighten(surface, 5) : darken(surface, 5);
    out['--bg-hover'] = withAlpha(tint, 0.06);
    out['--bg-active'] = withAlpha(tint, 0.1);
    out['--border-color'] = withAlpha(tint, 0.12);
    out['--border-color-light'] = withAlpha(tint, 0.06);
    out['--border-color-input'] = withAlpha(tint, 0.2);
  }

  if (resolvedText) {
    const toward = surface ?? BASE_SURFACE[base];
    out['--text-primary'] = resolvedText;
    out['--text-secondary'] = mix(resolvedText, toward, 0.2);
    out['--text-muted'] = mix(resolvedText, toward, 0.45);
    out['--text-faint'] = mix(resolvedText, toward, 0.6);
  }

  return out;
}

/** A curated, on-white-safe preset (per base). `inputs` are sparse. */
export interface ThemePreset {
  id: string;
  label: string;
  light: ThemeInputs;
  dark: ThemeInputs;
}

/**
 * Safe starter presets. `default` is empty (the hand-tuned base). Values are
 * intentionally conservative — tuned over time; the point is the mechanism.
 */
export const THEME_PRESETS: ThemePreset[] = [
  { id: 'default', label: 'Default', light: {}, dark: {} },
  { id: 'ocean', label: 'Ocean', light: { primary: '#0f6fa8' }, dark: { primary: '#7cc6ec' } },
  { id: 'forest', label: 'Forest', light: { primary: '#0f766e' }, dark: { primary: '#5eead4' } },
  { id: 'plum', label: 'Plum', light: { primary: '#7e22ce' }, dark: { primary: '#d8b4fe' } },
  { id: 'ember', label: 'Ember', light: { primary: '#b4530a' }, dark: { primary: '#fcd34d' } },
];

/**
 * Generate a tasteful, contrast-safe random theme for a base ("Surprise me").
 * Lightness is constrained per base so the derived on-color and Primary↔Surface
 * contrast stay legible; hue/sat are free for variety.
 */
export function surpriseTheme(base: ThemeBase): ThemeInputs {
  const sat = 45 + Math.floor(Math.random() * 25); // 45–70%
  // Build a hue at a lightness guaranteed to give an AA-legible on-color, by
  // pushing lightness away from the mid "dead zone" (where neither ink nor paper
  // reaches AA) until it does — perceptual luminance varies by hue, so we check.
  const safeFill = (hue: number): string => {
    let l = base === 'dark' ? 70 : 38;
    const step = base === 'dark' ? 3 : -3;
    for (let i = 0; i < 14; i++) {
      const hex = rgbToHex(hslToRgb({ h: hue, s: sat, l }));
      if (contrastRatio(onColor(hex), hex) >= 4.6) return hex;
      l = Math.max(4, Math.min(96, l + step));
    }
    return rgbToHex(hslToRgb({ h: hue, s: sat, l }));
  };
  const hue = Math.floor(Math.random() * 360);
  return { primary: safeFill(hue), cta: safeFill((hue + 150) % 360) };
}

/**
 * Representative base-default color per slot per base (mirrors index.css), shown
 * in the builder when a slot is *not* overridden so the swatch reflects reality.
 */
export const BASE_SWATCHES: Record<ThemeBase, Record<ThemeColorSlot, string>> = {
  light: { primary: '#1f3354', cta: '#c9a262', surface: '#f9f6ee', text: '#0a1525' },
  dark: { primary: '#e0c690', cta: '#c9a262', surface: '#0e1c30', text: '#f6f4ec' },
};

/**
 * Prose editor background presets. Values are token-referencing CSS `background`
 * strings, so each adapts to the active theme *and* a custom Surface for free.
 * `default` has `value: null` → no `--prose-bg` override, so the panel keeps its
 * built-in per-base behavior (flat in light, the dark glow in dark).
 */
export const PROSE_BACKGROUNDS: Record<ProseBackground, { label: string; value: string | null }> = {
  default: { label: 'Default', value: null },
  flat: { label: 'Flat', value: 'var(--bg-primary)' },
  glow: {
    label: 'Glow',
    value:
      'radial-gradient(140% 90% at 50% 0%, var(--bg-tertiary) 0%, var(--bg-primary) 45%, var(--bg-secondary) 100%)',
  },
  aurora: {
    label: 'Aurora',
    value: 'linear-gradient(180deg, var(--color-primary-light) 0%, var(--bg-primary) 45%)',
  },
};

/** Slots in display order, with plain labels for the builder UI. */
export const THEME_SLOTS: ReadonlyArray<{ slot: ThemeColorSlot; label: string; hint: string }> = [
  { slot: 'primary', label: 'Primary', hint: 'Links, active states, primary buttons' },
  { slot: 'cta', label: 'Call-to-action', hint: 'Prominent action buttons' },
  { slot: 'surface', label: 'Surface', hint: 'Page and panel backgrounds' },
  { slot: 'text', label: 'Text', hint: 'Body text colour' },
];
