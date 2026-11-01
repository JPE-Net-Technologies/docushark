/**
 * The light theme's glare (DSK-204).
 *
 * The founder: "The dull white is nice but the sharp whites are disorientating."
 * The tokens were already the dull whites (`--bg-primary` #f9f6ee); the glare
 * was a pure white canvas inside warm chrome, plus a few component surfaces
 * hard-coded to white. These pin the canvas to the token and keep opaque white
 * surfaces out of component CSS.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { useThemeStore } from './themeStore';

/** A light-theme token's value: its first definition in index.css (the light `:root`). */
function lightToken(name: string): string {
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
  return css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim() ?? '';
}

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...cssFiles(path));
    else if (name.endsWith('.css')) out.push(path);
  }
  return out;
}

/** Opaque white backgrounds that are not surfaces, with why. */
const ALLOWED = new Set([
  // The dot inside a selected, primary-filled cell: an indicator, not a surface.
  'src/ui/LabelPositionPicker.css .label-position-cell.selected .label-position-dot',
]);

beforeAll(() => {
  useThemeStore.getState().setPreference('light');
});

describe('the light theme (DSK-204)', () => {
  it('paints the canvas in the app surface tone, not pure white', () => {
    const { backgroundColor } = useThemeStore.getState().colors;
    expect(backgroundColor).toBe(lightToken('--bg-primary'));
    expect(backgroundColor.toLowerCase()).not.toBe('#ffffff');
  });

  it('keeps a white page behind exported diagrams', () => {
    expect(useThemeStore.getState().colors.exportBackgroundColor).toBe('#ffffff');
  });

  it('has no opaque white surfaces in component CSS', () => {
    const offenders: string[] = [];
    for (const file of cssFiles(resolve(process.cwd(), 'src'))) {
      const rel = relative(process.cwd(), file);
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, selector = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/background(?:-color)?\s*:\s*(?:#fff\b|#ffffff\b|white\b)/i.test(body)) continue;
        const key = `${rel} ${selector.trim().replace(/\s+/g, ' ')}`;
        if (!ALLOWED.has(key)) offenders.push(key);
      }
    }
    expect(offenders).toEqual([]);
  });
});
