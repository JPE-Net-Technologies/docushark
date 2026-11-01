/**
 * The boot screen in index.html (DSK-205).
 *
 * Before the bundle runs, the page painted in the browser default: blank, and
 * white even for someone in the dark theme. index.html now applies the saved
 * theme from a tiny inline script and shows a branded splash inside #root,
 * which React's first render replaces. These run that script against the
 * states it must handle, pin where the splash lives, and hold the colours it
 * copies to the app's tokens.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const appCss = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
/** The classic (non-module) inline script: the theme boot. */
const bootScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
/** The splash's inline styles. */
const bootCss = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

/** A token's value in index.css: its first definition (the light `:root`), or the dark block's. */
function token(name: string, theme: 'light' | 'dark' = 'light'): string {
  const from = theme === 'dark' ? appCss.indexOf('[data-theme="dark"] {') : 0;
  return appCss.slice(from).match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim() ?? '';
}

/** A declaration in the splash's styles, by exact selector. */
function bootStyle(selector: string, property: string): string {
  for (const [, sel = '', body = ''] of bootCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (sel.trim() !== selector) continue;
    const value = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1];
    if (value) return value.trim();
  }
  return '';
}

function boot(stored: string | null, systemDark: boolean): { theme: string | null; statusBar: string | null } {
  if (stored === null) localStorage.removeItem('docushark-theme');
  else localStorage.setItem('docushark-theme', stored);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: systemDark && query.includes('dark') }));
  new Function(bootScript)();
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    statusBar: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
  };
}

beforeEach(() => {
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = '#f9f6ee';
  document.head.appendChild(meta);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.head.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
});

const persisted = (preference: string) => JSON.stringify({ state: { preference }, version: 0 });

describe('the boot screen (DSK-205)', () => {
  it('has a theme script to run', () => {
    expect(bootScript).toContain('docushark-theme');
  });

  // The status bar takes the surface colour, as themeStore's applyThemeColorMeta does.
  it('applies a saved dark theme before the app loads', () => {
    expect(boot(persisted('dark'), false)).toEqual({ theme: 'dark', statusBar: token('--bg-primary', 'dark') });
  });

  it('applies a saved light theme even when the system is dark', () => {
    expect(boot(persisted('light'), true)).toEqual({ theme: 'light', statusBar: token('--bg-primary') });
  });

  it('follows the system when the preference is "system" or never saved', () => {
    expect(boot(persisted('system'), true).theme).toBe('dark');
    expect(boot(null, true).theme).toBe('dark');
    expect(boot(null, false).theme).toBe('light');
  });

  it('falls back to light on an unreadable record instead of throwing', () => {
    expect(boot('{not json', true).theme).toBe('light');
  });

  it('puts the splash inside #root, so the first render replaces it', () => {
    const page = new DOMParser().parseFromString(html, 'text/html');
    const splash = page.querySelector('#root > .boot-splash');
    expect(splash?.getAttribute('role')).toBe('status');
    expect(splash?.textContent).toContain('Loading DocuShark…');
  });

  it('shows an image the service worker precaches, so an offline boot has it', () => {
    const src = new DOMParser().parseFromString(html, 'text/html').querySelector('.boot-splash img')?.getAttribute('src');
    const config = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    // vite-plugin-pwa precaches `includeAssets` and, by default, the manifest icons.
    const listed = (block: RegExp, item: RegExp) =>
      [...(config.match(block)?.[1] ?? '').matchAll(item)].map((m) => `/${m[1]?.replace(/^\//, '')}`);
    const precached = [
      ...listed(/includeAssets:\s*\[([^\]]*)\]/, /'([^']+)'/g),
      ...listed(/icons:\s*\[([^\]]*)\]/, /src:\s*'([^']+)'/g),
    ];
    expect(precached.length).toBeGreaterThan(0);
    expect(precached).toContain(src);
  });

  it('copies its colours from the app theme', () => {
    const copies: Array<[selector: string, property: string, source: string]> = [
      // The body's background: --bg-secondary, and --navy-1000 in dark.
      ['html', 'background', token('--bg-secondary')],
      ["html[data-theme='dark']", 'background', token('--navy-1000')],
      ['.boot-splash', 'color', token('--text-primary')],
      ["html[data-theme='dark'] .boot-splash", 'color', token('--text-primary', 'dark')],
      ['.boot-splash__name span', 'color', token('--brand-gold-deep')],
      ["html[data-theme='dark'] .boot-splash__name span", 'color', token('--brand-gold-soft')],
    ];
    for (const [selector, property, source] of copies) {
      expect(source).toMatch(/^#[0-9a-f]{6}$/i);
      expect(`${selector} ${property}: ${bootStyle(selector, property)}`).toBe(`${selector} ${property}: ${source}`);
    }
  });
});
