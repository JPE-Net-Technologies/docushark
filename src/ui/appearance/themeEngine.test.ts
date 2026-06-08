import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveThemeOverrides,
  surpriseTheme,
  onColor,
  THEME_CONTROLLED_TOKENS,
  THEME_PRESETS,
  THEME_INK,
  THEME_PAPER,
  BASE_SWATCHES,
} from './themeEngine';
import { contrastRatio } from '../../utils/color';
import type { ThemeBase } from '../../store/uiPreferencesStore';

const BASES: ThemeBase[] = ['light', 'dark'];
const CONTROLLED = new Set<string>(THEME_CONTROLLED_TOKENS);
/** Accept hex or rgb()/rgba() — the only forms the engine emits. */
const VALID = /^#[0-9a-f]{6}$|^rgba?\(/i;

function randHex(): string {
  return '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
}

describe('themeEngine — completeness', () => {
  it('empty inputs produce no overrides (base is untouched)', () => {
    for (const base of BASES) {
      expect(resolveThemeOverrides(base, {})).toEqual({});
    }
  });

  it('a set Primary writes its whole token family', () => {
    const out = resolveThemeOverrides('light', { primary: '#3366cc' });
    for (const t of ['--color-primary', '--color-primary-dark', '--color-primary-light', '--color-primary-alpha', '--color-on-primary']) {
      expect(out[t as keyof typeof out]).toBeTruthy();
    }
  });

  it('every emitted token is controlled and a valid color, across presets + fuzz', () => {
    const cases = [
      ...THEME_PRESETS.flatMap((p) => [
        { base: 'light' as const, inputs: p.light },
        { base: 'dark' as const, inputs: p.dark },
      ]),
      ...Array.from({ length: 200 }, () => ({
        base: (Math.random() < 0.5 ? 'light' : 'dark') as ThemeBase,
        inputs: { primary: randHex(), cta: randHex(), surface: randHex(), text: randHex() },
      })),
    ];
    for (const { base, inputs } of cases) {
      const out = resolveThemeOverrides(base, inputs);
      for (const [token, value] of Object.entries(out)) {
        expect(CONTROLLED.has(token)).toBe(true);
        expect(value).toMatch(VALID);
      }
    }
  });

  it('on-fill text always picks the more legible of ink/paper', () => {
    for (let i = 0; i < 200; i++) {
      const primary = randHex();
      const chosen = onColor(primary);
      const other = chosen === THEME_PAPER ? THEME_INK : THEME_PAPER;
      // The engine never leaves a more-readable option on the table.
      expect(contrastRatio(chosen, primary)).toBeGreaterThanOrEqual(contrastRatio(other, primary));
    }
  });

  it('curated presets keep on-Primary text AA-legible', () => {
    for (const preset of THEME_PRESETS) {
      for (const base of BASES) {
        const primary = preset[base].primary;
        if (!primary) continue;
        expect(contrastRatio(onColor(primary), primary)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('themeEngine — drift guard', () => {
  it('every controlled token is defined in index.css (no engine typo / drift)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    for (const token of THEME_CONTROLLED_TOKENS) {
      expect(css.includes(`${token}:`)).toBe(true);
    }
  });

  it('base swatches cover every base + slot', () => {
    for (const base of BASES) {
      for (const slot of ['primary', 'cta', 'surface', 'text'] as const) {
        expect(BASE_SWATCHES[base][slot]).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});

describe('themeEngine — surprise me', () => {
  it('generates a legible primary for the base', () => {
    for (const base of BASES) {
      for (let i = 0; i < 50; i++) {
        const inputs = surpriseTheme(base);
        const out = resolveThemeOverrides(base, inputs);
        expect(contrastRatio(out['--color-on-primary'] as string, inputs.primary as string)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
