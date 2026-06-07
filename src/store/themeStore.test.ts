import { describe, it, expect, beforeEach } from 'vitest';
import { useThemeStore } from './themeStore';

const KEY = 'docushark-theme';

describe('themeStore persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset to the default preference between tests (derived fields recomputed
    // via setPreference).
    useThemeStore.getState().setPreference('system');
  });

  it('persists the user preference to localStorage', () => {
    useThemeStore.getState().setPreference('dark');
    const raw = localStorage.getItem(KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).state.preference).toBe('dark');
  });

  it('applies the resolved theme to the document on change', () => {
    useThemeStore.getState().setPreference('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(useThemeStore.getState().resolvedTheme).toBe('dark');
    expect(useThemeStore.getState().colors.backgroundColor).toBe('#1e1e1e');
  });

  it('recomputes derived theme from a persisted preference on rehydrate', async () => {
    // Simulate a prior session that saved a Dark preference.
    localStorage.setItem(
      KEY,
      JSON.stringify({ state: { preference: 'dark' }, version: 0 })
    );
    await useThemeStore.persist.rehydrate();

    const state = useThemeStore.getState();
    expect(state.preference).toBe('dark');
    // The merge must recompute resolvedTheme + colors, not leave the pre-hydration default.
    expect(state.resolvedTheme).toBe('dark');
    expect(state.colors.backgroundColor).toBe('#1e1e1e');
  });

  it('keeps theme-color meta in sync with the active theme', () => {
    useThemeStore.getState().setPreference('dark');
    const meta = document.querySelector('meta[name="theme-color"]');
    expect(meta).toBeTruthy();
    // jsdom returns empty for the CSS custom property, so the fallback applies.
    expect(meta?.getAttribute('content')).toBe('#0e1c30');
  });
});
