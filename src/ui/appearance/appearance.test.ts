import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import { useThemeStore } from '../../store/themeStore';
// Importing the applier boots its module-level store subscriptions.
import './applyAppearance';
import { getAppearanceSnapshot, applyAppearanceSnapshot, resetAppearance } from './appearanceConfig';

beforeEach(() => {
  localStorage.clear();
  useUIPreferencesStore.getState().reset();
  useThemeStore.getState().setPreference('light'); // deterministic active base
});

afterEach(() => {
  const s = useUIPreferencesStore.getState();
  s.resetThemeBuild();
  s.setMotion('system');
  s.setDensity('normal');
  s.setUiScale(1);
});

describe('appearance applier (Abstraction A)', () => {
  it('writes resolved theme overrides for the active base onto the root', () => {
    useUIPreferencesStore.getState().setThemeInput('light', 'primary', '#3366cc');
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--color-primary')).toBe('#3366cc');
    // Derived relatives are written too (no missing tokens for a set slot).
    expect(style.getPropertyValue('--color-on-primary')).not.toBe('');
    expect(style.getPropertyValue('--color-primary-alpha')).not.toBe('');
  });

  it('reverts the inline override when a slot is cleared', () => {
    const s = useUIPreferencesStore.getState();
    s.setThemeInput('light', 'primary', '#3366cc');
    s.setThemeInput('light', 'primary', undefined);
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('');
  });

  it('routes motion through the adaptive budget (data-reduced-motion)', () => {
    useUIPreferencesStore.getState().setMotion('reduced');
    expect(document.documentElement.dataset['reducedMotion']).toBe('true');
    useUIPreferencesStore.getState().setMotion('full');
    expect(document.documentElement.dataset['reducedMotion']).toBeUndefined();
  });

  it('mirrors density + UI scale onto the document root', () => {
    useUIPreferencesStore.getState().setDensity('compact');
    useUIPreferencesStore.getState().setUiScale(1.2);
    expect(document.documentElement.dataset['density']).toBe('compact');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.2');
  });
});

describe('appearance snapshot seam (Abstraction B)', () => {
  it('captures the full appearance config', () => {
    useThemeStore.getState().setPreference('dark');
    const s = useUIPreferencesStore.getState();
    s.setThemeInput('dark', 'primary', '#abcdef');
    s.setMotion('reduced');
    s.setDensity('spacious');
    s.setUiScale(1.15);
    expect(getAppearanceSnapshot()).toEqual({
      theme: 'dark',
      themeInputs: { light: {}, dark: { primary: '#abcdef' } },
      motion: 'reduced',
      density: 'spacious',
      uiScale: 1.15,
    });
  });

  it('applies a config across both stores', () => {
    applyAppearanceSnapshot({
      theme: 'light',
      themeInputs: { light: { primary: '#112233' }, dark: {} },
      motion: 'full',
      density: 'compact',
      uiScale: 1.1,
    });
    expect(useThemeStore.getState().preference).toBe('light');
    const ap = useUIPreferencesStore.getState().appearancePrefs;
    expect(ap.themeInputs).toEqual({ light: { primary: '#112233' }, dark: {} });
    expect(ap.motion).toBe('full');
  });

  it('resetAppearance restores every default', () => {
    useThemeStore.getState().setPreference('dark');
    const s = useUIPreferencesStore.getState();
    s.setThemeInput('dark', 'primary', '#ff0000');
    s.setMotion('reduced');
    resetAppearance();
    expect(getAppearanceSnapshot()).toEqual({
      theme: 'system',
      themeInputs: { light: {}, dark: {} },
      motion: 'system',
      density: 'normal',
      uiScale: 1,
    });
  });
});
