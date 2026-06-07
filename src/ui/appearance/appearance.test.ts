import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import { useThemeStore } from '../../store/themeStore';
// Importing the applier boots its module-level store subscription.
import './applyAppearance';
import { getAppearanceSnapshot, applyAppearanceSnapshot, resetAppearance } from './appearanceConfig';

beforeEach(() => {
  localStorage.clear();
  useUIPreferencesStore.getState().reset();
  useThemeStore.getState().setPreference('system');
});

afterEach(() => {
  const s = useUIPreferencesStore.getState();
  s.setAccent('default');
  s.setMotion('system');
  s.setDensity('normal');
  s.setUiScale(1);
});

describe('appearance applier (Abstraction A)', () => {
  it('mirrors the accent onto the document root', () => {
    useUIPreferencesStore.getState().setAccent('violet');
    expect(document.documentElement.dataset['accent']).toBe('violet');
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
    s.setAccent('amber');
    s.setMotion('reduced');
    s.setDensity('spacious');
    s.setUiScale(1.15);
    expect(getAppearanceSnapshot()).toEqual({
      theme: 'dark',
      accent: 'amber',
      motion: 'reduced',
      density: 'spacious',
      uiScale: 1.15,
    });
  });

  it('applies a config across both stores', () => {
    applyAppearanceSnapshot({ theme: 'light', accent: 'rose', motion: 'full', density: 'compact', uiScale: 1.1 });
    expect(useThemeStore.getState().preference).toBe('light');
    expect(useUIPreferencesStore.getState().appearancePrefs).toEqual({
      accent: 'rose',
      motion: 'full',
      density: 'compact',
      uiScale: 1.1,
    });
  });

  it('resetAppearance restores every default', () => {
    useThemeStore.getState().setPreference('dark');
    const s = useUIPreferencesStore.getState();
    s.setAccent('teal');
    s.setMotion('reduced');
    s.setDensity('compact');
    s.setUiScale(1.2);
    resetAppearance();
    expect(getAppearanceSnapshot()).toEqual({
      theme: 'system',
      accent: 'default',
      motion: 'system',
      density: 'normal',
      uiScale: 1,
    });
  });
});
