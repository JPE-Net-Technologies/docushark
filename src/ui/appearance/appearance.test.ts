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
  useUIPreferencesStore.getState().setAccent('default');
  useUIPreferencesStore.getState().setMotion('system');
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
});

describe('appearance snapshot seam (Abstraction B)', () => {
  it('captures theme + accent + motion', () => {
    useThemeStore.getState().setPreference('dark');
    useUIPreferencesStore.getState().setAccent('amber');
    useUIPreferencesStore.getState().setMotion('reduced');
    expect(getAppearanceSnapshot()).toEqual({ theme: 'dark', accent: 'amber', motion: 'reduced' });
  });

  it('applies a config across both stores', () => {
    applyAppearanceSnapshot({ theme: 'light', accent: 'rose', motion: 'full' });
    expect(useThemeStore.getState().preference).toBe('light');
    expect(useUIPreferencesStore.getState().appearancePrefs).toEqual({ accent: 'rose', motion: 'full' });
  });

  it('resetAppearance restores every default', () => {
    useThemeStore.getState().setPreference('dark');
    useUIPreferencesStore.getState().setAccent('teal');
    useUIPreferencesStore.getState().setMotion('reduced');
    resetAppearance();
    expect(getAppearanceSnapshot()).toEqual({ theme: 'system', accent: 'default', motion: 'system' });
  });
});
