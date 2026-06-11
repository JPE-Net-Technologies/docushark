import { describe, it, expect } from 'vitest';
import { useSettingsStore, migrateSettings } from './settingsStore';

describe('settingsStore default connector routing', () => {
  it('defaults new connectors to straight routing', () => {
    // jsdom localStorage is empty, so the store falls back to initial state.
    expect(useSettingsStore.getState().defaultConnectorType).toBe('straight');
  });
});

describe('migrateSettings (v0 → v1)', () => {
  it('rewrites the stale v0 orthogonal default to straight', () => {
    const result = migrateSettings({ defaultConnectorType: 'orthogonal' }, 0);
    expect(result.defaultConnectorType).toBe('straight');
  });

  it('leaves a v0 straight value alone', () => {
    const result = migrateSettings({ defaultConnectorType: 'straight' }, 0);
    expect(result.defaultConnectorType).toBe('straight');
  });

  it('does not touch an orthogonal value already stored at v1 (a deliberate choice)', () => {
    const result = migrateSettings({ defaultConnectorType: 'orthogonal' }, 1);
    expect(result.defaultConnectorType).toBe('orthogonal');
  });

  it('preserves other persisted fields', () => {
    const result = migrateSettings(
      { defaultConnectorType: 'orthogonal', showMinimap: true, gridOpacity: 0.3 },
      0
    );
    expect(result.defaultConnectorType).toBe('straight');
    expect(result.showMinimap).toBe(true);
    expect(result.gridOpacity).toBe(0.3);
  });

  it('tolerates empty/undefined persisted state', () => {
    expect(migrateSettings(undefined, 0)).toEqual({});
  });
});
